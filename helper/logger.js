// ============================================================
//   helper/logger.js  –  console output
// ------------------------------------------------------------
//   Style matched to the reference build
//   (blacklorddev15/Tes-r-po -> Skylar X ULTRA panel):
//     * every line carries a blue-bold  [ BRAND ]  tag
//     * the per-message banner is drawn in rainbow and uses the
//       same field set (Sent Time / Date / Message Type /
//       Sender Name / Chat ID / Group / Message)
//
//   Two differences from that build, both deliberate:
//     * colour is FORCED. A panel console is not a TTY, so chalk
//       otherwise detects "no colour support" and strips every
//       escape code — which is why this output looked plain.
//     * lolcatjs is optional. If it is installed it is used, byte
//       for byte like the reference; otherwise an identical
//       chalk.rgb rainbow is drawn instead of printing uncoloured.
// ============================================================
'use strict';

process.env.FORCE_COLOR = process.env.FORCE_COLOR || '3';

const chalk = require('chalk');
try { chalk.level = 3; } catch (_) {}

const lolcat = (() => {
  try { return require('lolcatjs'); } catch { return null; }
})();

// Brand shown in the banner box and in the [ … ] tag on every line.
const BRAND = process.env.BOT_BRAND || 'TALKLESS X ULTRA';

const BOX_TOP    = `┏━━━━━━━━━━━━━『  ${BRAND}  』━━━━━━━━━━━━━─`;
const BOX_BOTTOM = '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━─ ⳹';

/* ── rainbow (used when lolcatjs is unavailable) ─────────────── */

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Cycles a full hue roughly every 70 characters and shifts a little on each
// banner, so consecutive blocks are coloured differently — the look of the
// reference console.
let phase = 0;
function rainbow(text) {
  let out = '';
  let colourIndex = phase;
  for (const ch of text) {
    if (ch === '\n') { out += ch; continue; }
    const rgb = hsvToRgb((colourIndex * 5.1 + phase * 37) % 360, 1, 1);
    out += chalk.rgb(rgb[0], rgb[1], rgb[2])(ch);
    colourIndex += 1;
  }
  phase += 11;
  return out;
}

/* ── the tagged logger (reference: global.log) ───────────────── */

function skylarLog(msg, color = 'white', isErr = false) {
  const tag   = chalk.blue.bold(`[ ${BRAND} ]`);
  const paint = chalk[color] ? chalk[color](msg) : String(msg);
  const out   = isErr ? console.error : console.log;

  if (String(msg).includes('\n') || String(msg).includes('════')) out(tag, paint);
  else out(`${tag} ${paint}`);
}
global.log = skylarLog;

/* ── rainbow banner ──────────────────────────────────────────── */

function banner(lines, useRainbow = true) {
  const block = [BOX_TOP, ...lines, BOX_BOTTOM].join('\n');
  if (useRainbow) {
    if (lolcat && typeof lolcat.fromString === 'function') {
      try { lolcat.fromString(block); return; } catch { /* fall through */ }
    }
    console.log(rainbow(block));
    return;
  }
  console.log(block);
}

/* ── message type helpers ────────────────────────────────────── */

const icons = {
  text: '💬', image: '🖼 ', video: '🎥', audio: '🎵', sticker: '🌀',
  document: '📄', location: '📍', contact: '👤', reaction: '❤️', poll: '📊',
  viewOnce: '👁 ', unknown: '❓',
};

function getMsgType(msg) {
  if (!msg) return 'unknown';
  if (msg.conversation || msg.extendedTextMessage)    return 'text';
  if (msg.imageMessage)     return 'image';
  if (msg.videoMessage)     return 'video';
  if (msg.audioMessage)     return 'audio';
  if (msg.stickerMessage)   return 'sticker';
  if (msg.documentMessage)  return 'document';
  if (msg.locationMessage)  return 'location';
  if (msg.contactMessage)   return 'contact';
  if (msg.reactionMessage)  return 'reaction';
  if (msg.pollCreationMessage) return 'poll';
  if (msg.viewOnceMessage || msg.viewOnceMessageV2) return 'viewOnce';
  return 'unknown';
}

function getMsgText(msg) {
  if (!msg) return '';
  // In the reference this was one `||` chain ending in
  // `… || msg.locationMessage ? \`[…]\` : …`, and because a ternary binds
  // looser than ||, every text message rendered as "[undefined, undefined]".
  // The location case is handled separately here.
  const text =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.reactionMessage?.text ||
    msg.pollCreationMessage?.name ||
    msg.contactMessage?.displayName ||
    '';
  if (text) return text;

  if (msg.locationMessage) {
    const lat = Number(msg.locationMessage.degreesLatitude);
    const lng = Number(msg.locationMessage.degreesLongitude);
    return (Number.isFinite(lat) && Number.isFinite(lng))
      ? `[${lat.toFixed(4)}, ${lng.toFixed(4)}]`
      : '[location]';
  }
  return '';
}

function logMessage(m, chatMeta = {}) {
  try {
    const raw      = m.message;
    let realMsg    = raw;
    const wrappers = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    for (const w of wrappers) { if (realMsg?.[w]?.message) realMsg = realMsg[w].message; }

    const type   = getMsgType(realMsg);
    const icon   = icons[type] || icons.unknown;
    // Collapse newlines so multi-line messages stay inside the box.
    const text   = getMsgText(realMsg).replace(/\s*\n+\s*/g, ' ↵ ').replace(/[ \t]+/g, ' ').slice(0, 300);
    const sender = String(m.key.participant || m.key.remoteJid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    const name   = m.pushName || sender;
    const jid    = m.key.remoteJid || '';
    const isGrp  = jid.endsWith('@g.us');
    const isChan = jid.endsWith('@newsletter');
    const tz     = process.env.TZ || 'Africa/Nairobi';

    const ts      = new Date(Number(m.messageTimestamp || 0) * 1000 || Date.now());
    const timeStr = ts.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
    const dayStr  = ts.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long' });
    const dateStr = ts.toLocaleDateString('en-GB', { timeZone: tz });

    const lines = [
      `»  Sent Time: ${dayStr}, ${timeStr}`,
      `»  Date: ${dateStr}`,
      `»  Message Type: ${icon} ${type}`,
      `»  Sender Name: ${name}`,
      `»  Chat ID: ${jid.split('@')[0]}`,
    ];
    if (isGrp) {
      lines.push(`»  Group: ${chatMeta.groupName || '(unknown)'}`);
      lines.push(`»  Group JID: ${jid.split('@')[0]}`);
    } else {
      lines.push(`»  Chat: ${isChan ? 'CHANNEL' : 'DM'}`);
    }
    if (text) lines.push(`»  Message: ${text}`);

    banner(lines);
  } catch { /* logging must never take the bot down */ }
}

const logInfo    = (label, msg) => skylarLog(`[INFO]  ${label}${msg ? ` – ${msg}` : ''}`, 'cyan');
const logSuccess = (label, msg) => skylarLog(`[OK]    ${label}${msg ? ` – ${msg}` : ''}`, 'green');
const logWarn    = (label, msg) => skylarLog(`[WARN]  ${label}${msg ? ` – ${msg}` : ''}`, 'yellow', true);
const logError   = (label, msg) => skylarLog(`[ERR]   ${label}${msg ? ` – ${msg}` : ''}`, 'red', true);
const logSession = (sessionId, status) => {
  const dot = status === 'connected' ? '🟢' : status === 'reconnecting' ? '🟡' : '🔴';
  skylarLog(`session : ${sessionId} ${dot} ${status}`, 'white');
};

module.exports = {
  BRAND, skylarLog, banner,
  logMessage, logInfo, logSuccess, logWarn, logError, logSession,
  getMsgType, getMsgText,
};
