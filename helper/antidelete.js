'use strict';

// Per-socket anti-delete recovery. Each paired WhatsApp socket gets its own
// cache and recovered messages are sent only to that socket's private JID.
const { getWaSettings, retrieveMessage } = require('./function');
const { normNum } = require('./groupAdmin');
const { logInfo, logError, logWarn } = require('./logger');

const MAX_CACHE = 3000;
const states = new WeakMap();

function stateFor(sock) {
  let state = states.get(sock);
  if (!state) {
    state = { cache: new Map(), recovered: new Set() };
    states.set(sock, state);
  }
  return state;
}

function pairedJid(sock) {
  const number = normNum(sock?.__waNum || sock?.user?.id || '');
  return /^\d{7,}$/.test(number) ? `${number}@s.whatsapp.net` : null;
}

function unwrap(message) {
  let value = message || {};
  for (let i = 0; i < 6; i++) {
    const wrapper = [
      'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
      'viewOnceMessageV2Extension', 'documentWithCaptionMessage',
    ].find(name => value?.[name]?.message);
    if (!wrapper) break;
    value = value[wrapper].message;
  }
  return value;
}

function contentType(message) {
  return Object.keys(message || {}).find(type => ![
    'senderKeyDistributionMessage', 'messageContextInfo', 'protocolMessage',
    'reactionMessage',
  ].includes(type));
}

function saveMessage(sock, message) {
  try {
    if (!message?.message || !message.key?.id) return;
    if (message.key.remoteJid === 'status@broadcast') return;
    if (message.message.protocolMessage) return;

    const state = stateFor(sock);
    const key = `${message.key.remoteJid}|${message.key.id}`;
    state.cache.set(key, {
      key: { ...message.key },
      message: message.message,
      pushName: message.pushName || '',
      time: Date.now(),
    });
    if (state.cache.size > MAX_CACHE) {
      state.cache.delete(state.cache.keys().next().value);
    }
  } catch (error) {
    logWarn('AntiDelete', `save failed: ${error.message}`);
  }
}

async function downloadMedia(sock, message, key) {
  const baileys = require('blacklord-baileys');
  const logger = { info(){}, error(){}, warn(){}, debug(){}, child(){ return this; } };
  try {
    return await baileys.downloadMediaMessage(
      { key, message }, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }
    );
  } catch (firstError) {
    const type = contentType(message);
    const contentTypeName = type ? type.replace(/Message$/, '').toLowerCase() : null;
    if (!contentTypeName || typeof baileys.downloadContentFromMessage !== 'function') throw firstError;
    const stream = await baileys.downloadContentFromMessage(message[type], contentTypeName);
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}

function getSaved(sock, key) {
  const state = stateFor(sock);
  return state.cache.get(`${key?.remoteJid}|${key?.id}`) ||
    retrieveMessage(key?.remoteJid, key?.id, sock.__waNum || 'default');
}

function deleteKeyFrom(input) {
  if (input?.key?.id) return input.key;
  if (input?.update?.message?.protocolMessage?.key) return input.update.message.protocolMessage.key;
  if (input?.update?.protocolMessage?.key) return input.update.protocolMessage.key;
  if (input?.message?.protocolMessage?.key) return input.message.protocolMessage.key;
  return null;
}

async function recoverOne(sock, key) {
  const owner = pairedJid(sock);
  if (!owner || !key?.id || key.fromMe) return;

  const state = stateFor(sock);
  const recoveryKey = `${key.remoteJid}|${key.id}`;
  if (state.recovered.has(recoveryKey)) return;
  state.recovered.add(recoveryKey);
  if (state.recovered.size > 10000) state.recovered.clear();

  const saved = getSaved(sock, key);
  if (!saved || saved.key.fromMe) return;

  const sender = saved.key.participant || saved.key.remoteJid;
  const deleter = key.participant || key.remoteJid;
  const senderNumber = normNum(sender);
  const deleterNumber = normNum(deleter);
  const name = saved.pushName || senderNumber || 'Unknown';
  let content = unwrap(saved.message);
  const type = contentType(content);
  if (!type) return;

  let chatName = 'Private chat';
  if (saved.key.remoteJid?.endsWith('@g.us')) {
    try { chatName = (await sock.groupMetadata(saved.key.remoteJid)).subject || 'Group'; }
    catch { chatName = 'Group'; }
  }
  const header = `🗑️ *ANTI-DELETE*\n\n👤 *Sender:* ${name} (+${senderNumber || 'unknown'})\n🧹 *Deleted by:* +${deleterNumber || 'unknown'}\n💬 *Chat:* ${chatName}\n🕒 *Sent:* ${new Date(saved.time).toLocaleString()}\n`;
  const mentions = [sender, deleter].filter(Boolean);
  const fail = async label => sock.sendMessage(owner, { text: `${header}\n📦 *Deleted ${label}* (media unavailable)`, mentions });

  try {
    logInfo('AntiDelete', `recovering ${type} for ${owner}`);
    if (type === 'conversation' || type === 'extendedTextMessage') {
      const text = content.conversation || content.extendedTextMessage?.text || '';
      await sock.sendMessage(owner, { text: `${header}\n📝 *Message:*\n${text}`, mentions });
      return;
    }

    if (['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'].includes(type)) {
      const buffer = await downloadMedia(sock, content, saved.key).catch(() => null);
      if (!buffer) return fail(type.replace('Message', ''));
      const data = content[type] || {};
      const caption = `${header}${data.caption ? `\n📝 *Caption:* ${data.caption}` : ''}`;
      if (type === 'imageMessage') return sock.sendMessage(owner, { image: buffer, caption, mentions });
      if (type === 'videoMessage') return sock.sendMessage(owner, { video: buffer, caption, mentions });
      if (type === 'audioMessage') {
        await sock.sendMessage(owner, { text: header, mentions });
        return sock.sendMessage(owner, { audio: buffer, mimetype: data.mimetype || 'audio/mpeg', ptt: !!data.ptt });
      }
      if (type === 'stickerMessage') {
        await sock.sendMessage(owner, { text: header, mentions });
        return sock.sendMessage(owner, { sticker: buffer });
      }
      return sock.sendMessage(owner, { document: buffer, mimetype: data.mimetype || 'application/octet-stream', fileName: data.fileName || 'file', caption, mentions });
    }

    await sock.sendMessage(owner, { text: `${header}\n📦 *Type:* ${type}`, mentions });
  } catch (error) {
    logError('AntiDelete', error.message);
    await fail(type.replace('Message', '')).catch(() => {});
  }
}

async function handleDelete(sock, input) {
  const settings = getWaSettings(sock?.__waNum || '');
  if (!settings.antidelete) return;
  const keys = Array.isArray(input?.keys) ? input.keys : [deleteKeyFrom(input)].filter(Boolean);
  for (const key of keys) await recoverOne(sock, key);
}

async function handleDeleteUpdate(sock, updates) {
  const settings = getWaSettings(sock?.__waNum || '');
  if (!settings.antidelete) return;
  const list = Array.isArray(updates) ? updates : [updates];
  for (const entry of list) {
    const update = entry?.update || {};
    const protocol = update.message?.protocolMessage || update.protocolMessage || {};
    const type = protocol.type;
    const isRevoke = Number(update.messageStubType) === 68 ||
      String(type).toUpperCase() === 'REVOKE' || Number(type) === 0;
    if (isRevoke) await recoverOne(sock, protocol.key || entry.key);
  }
}

module.exports = { saveMessage, handleDelete, handleDeleteUpdate };
