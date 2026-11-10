// ============================================================
//   helper/listeners.js  – ALL event listeners
//   antidelete, antilink, anticall, antimedia,
//   welcome/goodbye, group participant events
// ============================================================
'use strict';

const path = require('path');
const axios = require('axios');
const settings = require('../settings');
const { readJSON, writeJSON, ensureDir } = require('./utils');
const { normNum, getGroupAdminInfo } = require('./groupAdmin');
const { retrieveMessage, getWaSettings, setWaSetting } = require('./function');

const AUTO_REACT_EMOJIS = ['❤️', '🔥', '😂', '😍', '👏', '💯', '✨', '👍', '🤍', '😮', '🥳', '🙌'];
const { logInfo, logError, logWarn } = require('./logger');
const { generateWelcomeCard } = require('./welcomeImg');

const DB = (...f) => path.resolve(__dirname, '../database', ...f);
ensureDir(path.resolve(__dirname, '../database'));

// ── DB helpers ────────────────────────────────────────────────
function getDB(file) { return readJSON(DB(file), {}); }
function setDB(file, data) { writeJSON(DB(file), data); }
function getGroupFlag(file, jid)         { return !!(getDB(file)[jid]); }
function setGroupFlag(file, jid, val)    { const d = getDB(file); d[jid] = val; setDB(file, d); }

// ── Download media from baileys ───────────────────────────────
async function dlMedia(msgObj, keyObj) {
  const baileys = require('blacklord-baileys');
  const logger = { info(){}, error(){}, warn(){}, debug(){}, child(){ return this; } };
  try {
    return await baileys.downloadMediaMessage(
      { message: msgObj, key: keyObj }, 'buffer', {}, { logger }
    );
  } catch (firstError) {
    const type = Object.keys(msgObj || {}).find(k => /Message$/.test(k));
    const contentType = type ? type.replace(/Message$/, '').toLowerCase() : null;
    if (!contentType || typeof baileys.downloadContentFromMessage !== 'function') throw firstError;
    const stream = await baileys.downloadContentFromMessage(msgObj[type], contentType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}

// ── Fetch image as buffer from URL ───────────────────────────
async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
    return Buffer.from(res.data);
  } catch { return null; }
}

// ── Anti-delete adapter ───────────────────────────────────────
// The implementation is per socket, opt-in, and private-DM only.
const antiDelete = require('./antidelete');
const saveAntiDeleteMessage = (sock, message) => antiDelete.saveMessage(sock, message);
const handleAntiDelete = (sock, update) => antiDelete.handleDelete(sock, update);
const handleAntiDeleteUpdate = (sock, updates) => antiDelete.handleDeleteUpdate(sock, updates);

function unwrapMessage(message) {
  let value = message || {};
  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
    if (value[wrapper]?.message) value = value[wrapper].message;
  }
  return value;
}

function describeMessage(message) {
  const value = unwrapMessage(message);
  const type = Object.keys(value).find(k => !['messageContextInfo', 'senderKeyDistributionMessage', 'protocolMessage'].includes(k));
  if (!type) return '[message content unavailable]';
  const data = value[type] || {};
  const text = value.conversation || data.text || data.caption || data.contentText || data.selectedDisplayText;
  return text ? `${type}: ${String(text)}` : `[${type}]`;
}

async function handleAntiEditUpdate(sock, updates) {
  const c = getWaSettings(sock.__waNum || '');
  if (!c.antiedit) return;
  const ownerNumber = String(sock.__waNum || '').replace(/\D/g, '');
  if (!ownerNumber) return;
  const ownerJid = `${ownerNumber}@s.whatsapp.net`;
  const list = Array.isArray(updates) ? updates : [updates];
  for (const entry of list) {
    const update = entry?.update || {};
    const protocol = update.message?.protocolMessage || update.protocolMessage || {};
    const editedMessage = protocol.editedMessage || update.editedMessage || update.message?.editedMessage;
    const type = protocol.type;
    const isEdit = !!editedMessage || Number(type) === 14 || String(type).toUpperCase() === 'MESSAGE_EDIT';
    if (!isEdit || !entry.key || entry.key.fromMe) continue;
    const originalKey = protocol.key || entry.key;
    const original = retrieveMessage(originalKey.remoteJid || entry.key.remoteJid, originalKey.id || entry.key.id, sock.__waNum || 'default');
    const sender = original?.key?.participant || entry.key.participant || entry.key.remoteJid;
    const number = normNum(sender);
    const name = original?.pushName || entry.pushName || number || 'Unknown';
    const before = describeMessage(original?.message);
    const after = describeMessage(editedMessage);
    const chat = originalKey.remoteJid?.endsWith('@g.us') ? `Group: ${originalKey.remoteJid}` : 'Private chat';
    try {
      await sock.sendMessage(ownerJid, {
        text: `✏️ *Anti-Edit*\nSender: *${name}*\nNumber: *+${number || 'unknown'}*\n${chat}\n\nBefore:\n${before}\n\nAfter:\n${after}`,
      });
    } catch (e) { logWarn('AntiEdit', e.message); }
  }
}

async function handleAutoReact(sock, m) {
  const waNum = sock.__waNum || normNum(sock.user?.id || '');
  const c = getWaSettings(waNum);
  if (!c.autoReact || !m?.message || m.key?.fromMe || m.key?.remoteJid !== 'status@broadcast') return;
  const statusOwner = m.key.participant || m.key.participantPn || m.key.participantAlt;
  if (!statusOwner) { logWarn('AutoReact', 'Status message has no participant JID; skipped.'); return; }
  const emoji = AUTO_REACT_EMOJIS[Math.floor(Math.random() * AUTO_REACT_EMOJIS.length)];
  try {
    await sock.sendMessage('status@broadcast', { react: { text: emoji, key: m.key } }, { statusJidList: [statusOwner] });
  } catch (e) { logWarn('AutoReact', e.message); }
}

// Mark every received WhatsApp status as viewed for this paired account.
// This socket only emits the receipt; nothing is routed to the status sender,
// a group, or another paired session.
async function handleAutoViewStatus(sock, m) {
  const waNum = sock.__waNum || normNum(sock.user?.id || '');
  const c = getWaSettings(waNum);
  if (c.autoViewStatus === false || !m?.key || m.key.fromMe || m.key.remoteJid !== 'status@broadcast') return;
  try {
    await sock.readMessages([m.key]);
  } catch (e) { logWarn('AutoViewStatus', e.message); }
}

// ════════════════════════════════════════════════════════════
//   ANTILINK  –  full listener
// ════════════════════════════════════════════════════════════
const LINK_RE = /https?:\/\/|chat\.whatsapp\.com|t\.me\/|discord\.gg\/|bit\.ly\/|tinyurl\.com\//i;

async function checkAntilink(sock, m) {
  if (!m.key.remoteJid.endsWith('@g.us')) return;
  if (!getGroupFlag('antilink.json', m.key.remoteJid)) return;

  const body = [
    m.message?.conversation,
    m.message?.extendedTextMessage?.text,
    m.message?.imageMessage?.caption,
    m.message?.videoMessage?.caption,
  ].filter(Boolean).join(' ');

  if (!LINK_RE.test(body)) return;

  // Admins exempt
  const senderNum = normNum(m.key.participant || m.key.remoteJid);
  const { admins } = await getGroupAdminInfo(sock, m.key.remoteJid);
  if (admins.has(senderNum)) return;

  try { await sock.sendMessage(m.key.remoteJid, { delete: m.key }); } catch {}
  try {
    await sock.sendMessage(m.key.remoteJid, {
      text: `⚠️ @${senderNum} Links are not allowed here! Message deleted.`,
      mentions: [m.key.participant || m.key.remoteJid],
    });
  } catch {}
}

// ════════════════════════════════════════════════════════════
//   ANTIMEDIA  –  delete media from non-admins
// ════════════════════════════════════════════════════════════
async function checkAntiMedia(sock, m) {
  if (!m.key.remoteJid.endsWith('@g.us')) return;
  if (!getGroupFlag('antimedia.json', m.key.remoteJid)) return;

  const hasMedia = !!(
    m.message?.imageMessage || m.message?.videoMessage ||
    m.message?.audioMessage || m.message?.stickerMessage ||
    m.message?.documentMessage
  );
  if (!hasMedia) return;

  const senderNum = normNum(m.key.participant || m.key.remoteJid);
  const { admins } = await getGroupAdminInfo(sock, m.key.remoteJid);
  if (admins.has(senderNum)) return;

  try { await sock.sendMessage(m.key.remoteJid, { delete: m.key }); } catch {}
  try {
    await sock.sendMessage(m.key.remoteJid, {
      text: `🚫 @${senderNum} Media not allowed here.`,
      mentions: [m.key.participant || m.key.remoteJid],
    });
  } catch {}
}

// ════════════════════════════════════════════════════════════
//   ANTICALL
// ════════════════════════════════════════════════════════════
async function handleAntiCall(sock, call) {
  const c = getWaSettings(sock.__waNum || '');
  if (!c.anticall) return;
  for (const cCall of call) {
    if (cCall.status === 'offer') {
      try {
        await sock.rejectCall(cCall.id, cCall.from);
        await sock.sendMessage(cCall.from, { text: `❌ Sorry, I don't accept calls. Please text instead.` });
      } catch {}
    }
  }
}

// ════════════════════════════════════════════════════════════
//   WELCOME / GOODBYE  –  with generated image
// ════════════════════════════════════════════════════════════
// Track sent welcomes per session to avoid spam: jid+participant
const welcomeSent = new Set();

async function handleGroupParticipantsUpdate(sock, update) {
  const { id: groupJid, participants, action } = update;

  // WELCOME
  if (action === 'add' && getGroupFlag('welcome.json', groupJid)) {
    let groupPpUrl = null;
    try { groupPpUrl = await sock.profilePictureUrl(groupJid, 'image'); } catch {}

    let groupName = groupJid;
    try { const meta = await sock.groupMetadata(groupJid); groupName = meta.subject; } catch {}

    for (const participant of participants) {
      const dedupeKey = `${groupJid}:${participant}`;
      if (welcomeSent.has(dedupeKey)) continue;
      welcomeSent.add(dedupeKey);
      setTimeout(() => welcomeSent.delete(dedupeKey), 30000);

      const num  = normNum(participant);
      let ppUrl  = null;
      try { ppUrl = await sock.profilePictureUrl(participant, 'image'); } catch {}

      let pushName = num;
      try {
        const info = await sock.onWhatsApp(participant);
        if (info?.[0]?.name) pushName = info[0].name;
      } catch {}

      // Generate welcome card
      const cardBuf = await generateWelcomeCard({
        userName:   pushName,
        groupName,
        userPpUrl:  ppUrl,
        groupPpUrl,
      });

      const caption = `👋 *Welcome @${num}!*\n\nGlad to have you in *${groupName}*.\nPlease read the group rules and enjoy your stay! 🎉`;

      try {
        if (cardBuf) {
          await sock.sendMessage(groupJid, {
            image:    cardBuf,
            caption,
            mentions: [participant],
          });
        } else if (ppUrl) {
          // Fallback: fetch user profile pic and send as image (no canvas)
          try {
            const imgBuf = await fetchImageBuffer(ppUrl);
            if (imgBuf) {
              await sock.sendMessage(groupJid, {
                image:    imgBuf,
                caption,
                mentions: [participant],
              });
            } else {
              throw new Error('img fetch failed');
            }
          } catch {
            await sock.sendMessage(groupJid, {
              text:     caption,
              mentions: [participant],
            });
          }
        } else {
          // No profile pic at all – plain text welcome
          await sock.sendMessage(groupJid, {
            text:     caption,
            mentions: [participant],
          });
        }
      } catch (e) { logError('Welcome', e.message); }
    }
  }

  // GOODBYE
  if (action === 'remove' && getGroupFlag('goodbye.json', groupJid)) {
    let groupName = groupJid;
    try { const meta = await sock.groupMetadata(groupJid); groupName = meta.subject; } catch {}

    for (const participant of participants) {
      const num = normNum(participant);
      try {
        await sock.sendMessage(groupJid, {
          text:     `👋 *Goodbye @${num}!*\nWe'll miss you in *${groupName}*. Take care! 💜`,
          mentions: [participant],
        });
      } catch {}
    }
  }
}

// ── Exports for flag get/set (used by case.js commands) ──────
module.exports = {
  // listeners
  saveAntiDeleteMessage,
  handleAntiDelete,
  handleAntiDeleteUpdate,
  handleAntiEditUpdate,
  handleAutoReact,
  handleAutoViewStatus,
  checkAntilink,
  checkAntiMedia,
  handleAntiCall,
  handleGroupParticipantsUpdate,
  // flag helpers
  getGroupFlag,
  setGroupFlag,
};
