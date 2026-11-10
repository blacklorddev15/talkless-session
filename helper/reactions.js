// ============================================================
//   helper/reactions.js  –  50+ Reaction Commands
//   All reactions send a GIF + styled caption mentioning target
// ============================================================
'use strict';

const axios = require('axios');

// ── Reaction GIF pools (multiple fallbacks per type) ─────────
const GIFS = {
  hug:        ['https://media.tenor.com/GG6mOfuXVmQAAAAC/hug-anime.gif','https://media.tenor.com/od_2uqEFZeYAAAAC/hug.gif'],
  kiss:       ['https://media.tenor.com/W4Nk_8I9KG0AAAAC/anime-kiss.gif','https://media.tenor.com/HKbN0cS0T1MAAAAC/anime-kiss.gif'],
  slap:       ['https://media.tenor.com/Gh1NTYUAAAAC/anime-slap.gif','https://media.tenor.com/wJSXM9K8U7EAAAAC/slap-anime.gif'],
  pat:        ['https://media.tenor.com/6INvkVBqOv8AAAAC/head-pat-anime.gif','https://media.tenor.com/Auo0a0W58MIAAAAC/anime-pat.gif'],
  poke:       ['https://media.tenor.com/9VBMfIFoXiwAAAAC/poke.gif','https://media.tenor.com/PvCrRfGLtBIAAAAC/poke-anime.gif'],
  cuddle:     ['https://media.tenor.com/yhxz5lyA2j4AAAAC/cuddle-anime.gif','https://media.tenor.com/qExWhpbmgFIAAAAC/anime-cuddle.gif'],
  bite:       ['https://media.tenor.com/wbSSoeDH0LEAAAAC/bite-anime.gif','https://media.tenor.com/3pS-3SUGc3wAAAAC/bite.gif'],
  blush:      ['https://media.tenor.com/2Wr5k7V8HHQAAAAC/anime-blush.gif','https://media.tenor.com/Q6o6JMCwuqsAAAAC/blush-anime.gif'],
  cry:        ['https://media.tenor.com/Q-Xk8bUzFTQAAAAC/anime-crying.gif','https://media.tenor.com/3d36b9RV4zoAAAAC/anime-cry.gif'],
  dance:      ['https://media.tenor.com/RhScWJ8A0eIAAAAC/anime-dance.gif','https://media.tenor.com/vFqI2ixiCkAAAAAC/dance-anime.gif'],
  wave:       ['https://media.tenor.com/gFe1DjFJl9YAAAAC/wave-anime.gif','https://media.tenor.com/PVwBnpAU-tsAAAAC/anime-wave.gif'],
  wink:       ['https://media.tenor.com/4RJlkGkfqaMAAAAC/wink-anime.gif','https://media.tenor.com/jUniG2S0UnsAAAAC/wink.gif'],
  laugh:      ['https://media.tenor.com/JT-Cq8LBQ8MAAAAC/laugh-anime.gif','https://media.tenor.com/Q3Xs_RMaQW4AAAAC/anime-laugh.gif'],
  smile:      ['https://media.tenor.com/z9I62mzjFt4AAAAC/smile-anime.gif','https://media.tenor.com/pjcPRFk0KQEAAAAC/smile.gif'],
  angry:      ['https://media.tenor.com/AvS5UtKzQFkAAAAC/anime-angry.gif','https://media.tenor.com/bF2EBdcW_iUAAAAC/angry-anime.gif'],
  sad:        ['https://media.tenor.com/MOl7aO0KdosAAAAC/sad-anime.gif','https://media.tenor.com/j5ZM5pN2QKUAAAAC/anime-sad.gif'],
  scared:     ['https://media.tenor.com/mEGCJqEi8XYAAAAC/scared-anime.gif','https://media.tenor.com/GjxWO-j7WGYAAAAC/scared.gif'],
  sleep:      ['https://media.tenor.com/TXt3ogSSmzgAAAAC/sleeping-anime.gif','https://media.tenor.com/0X9t-d8ZsEEAAAAC/sleep-anime.gif'],
  nod:        ['https://media.tenor.com/sOJ0a0HsXCkAAAAC/nod-anime.gif','https://media.tenor.com/sOJ0a0HsXCkAAAAC/nod-anime.gif'],
  nom:        ['https://media.tenor.com/r6K1I9d0MXEAAAAC/nom-nom-anime.gif','https://media.tenor.com/Ps6xC3IA1x4AAAAC/nom.gif'],
  lick:       ['https://media.tenor.com/NbEf5JqMQigAAAAC/lick-anime.gif','https://media.tenor.com/E9hNxwCuOBwAAAAC/lick.gif'],
  punch:      ['https://media.tenor.com/gY0YfPOL75UAAAAC/punch-anime.gif','https://media.tenor.com/XJC16nDM6AkAAAAC/anime-punch.gif'],
  kick:       ['https://media.tenor.com/VBk3lHJB7ywAAAAC/kick-anime.gif','https://media.tenor.com/nkh_0wnDCVkAAAAC/kick.gif'],
  throw:      ['https://media.tenor.com/bGM3MXJP9A0AAAAC/throw-anime.gif','https://media.tenor.com/bGM3MXJP9A0AAAAC/throw-anime.gif'],
  shoot:      ['https://media.tenor.com/sLm63grNMqUAAAAC/anime-shoot.gif','https://media.tenor.com/sLm63grNMqUAAAAC/anime-shoot.gif'],
  facepalm:   ['https://media.tenor.com/tTEXL0KHI0MAAAAC/facepalm-anime.gif','https://media.tenor.com/w-jMClvXCeQAAAAC/facepalm.gif'],
  handshake:  ['https://media.tenor.com/wHoijJmXSqwAAAAC/handshake-anime.gif','https://media.tenor.com/wHoijJmXSqwAAAAC/handshake-anime.gif'],
  highfive:   ['https://media.tenor.com/uPzsDqL2nEcAAAAC/high-five-anime.gif','https://media.tenor.com/uPzsDqL2nEcAAAAC/high-five-anime.gif'],
  pout:       ['https://media.tenor.com/hKsS_X24pCIAAAAC/pout-anime.gif','https://media.tenor.com/hKsS_X24pCIAAAAC/pout-anime.gif'],
  stare:      ['https://media.tenor.com/lH7bS7KCl5MAAAAC/anime-stare.gif','https://media.tenor.com/lH7bS7KCl5MAAAAC/anime-stare.gif'],
  think:      ['https://media.tenor.com/2s22LvlLM70AAAAC/thinking-anime.gif','https://media.tenor.com/rWGqV6f08nUAAAAC/thinking.gif'],
  shrug:      ['https://media.tenor.com/ECl6JGcU-IcAAAAC/shrug-anime.gif','https://media.tenor.com/ECl6JGcU-IcAAAAC/shrug-anime.gif'],
  sigh:       ['https://media.tenor.com/7_U0y5t5z6oAAAAC/sigh-anime.gif','https://media.tenor.com/7_U0y5t5z6oAAAAC/sigh-anime.gif'],
  bored:      ['https://media.tenor.com/vNz5DnJGlVUAAAAC/bored-anime.gif','https://media.tenor.com/vNz5DnJGlVUAAAAC/bored-anime.gif'],
  excited:    ['https://media.tenor.com/K-wv4xGEpHUAAAAC/excited-anime.gif','https://media.tenor.com/K-wv4xGEpHUAAAAC/excited-anime.gif'],
  confused:   ['https://media.tenor.com/zBMRXpG8Y98AAAAC/confused-anime.gif','https://media.tenor.com/zBMRXpG8Y98AAAAC/confused-anime.gif'],
  cheer:      ['https://media.tenor.com/H7YEf9M1fhAAAAAC/cheer-anime.gif','https://media.tenor.com/H7YEf9M1fhAAAAAC/cheer-anime.gif'],
  yawn:       ['https://media.tenor.com/7yDqERjkbM8AAAAC/yawn-anime.gif','https://media.tenor.com/7yDqERjkbM8AAAAC/yawn-anime.gif'],
  run:        ['https://media.tenor.com/BvI3ZGJDx8UAAAAC/run-anime.gif','https://media.tenor.com/BvI3ZGJDx8UAAAAC/run-anime.gif'],
  nosebleed:  ['https://media.tenor.com/tC9fLxd8SocAAAAC/nosebleed-anime.gif','https://media.tenor.com/tC9fLxd8SocAAAAC/nosebleed-anime.gif'],
  faint:      ['https://media.tenor.com/U0bIdBFt4FAAAAAC/faint-anime.gif','https://media.tenor.com/U0bIdBFt4FAAAAAC/faint-anime.gif'],
  celebrate:  ['https://media.tenor.com/IKwGGtf2HVQAAAAC/celebrate-anime.gif','https://media.tenor.com/IKwGGtf2HVQAAAAC/celebrate-anime.gif'],
  love:       ['https://media.tenor.com/jMvKSx8QSrEAAAAC/love-anime.gif','https://media.tenor.com/jMvKSx8QSrEAAAAC/love-anime.gif'],
  kill:       ['https://media.tenor.com/4YZ2e4DOiPwAAAAC/kill-anime.gif','https://media.tenor.com/4YZ2e4DOiPwAAAAC/kill-anime.gif'],
  feed:       ['https://media.tenor.com/DRqAHwW5q38AAAAC/feed-anime.gif','https://media.tenor.com/DRqAHwW5q38AAAAC/feed-anime.gif'],
  hold:       ['https://media.tenor.com/2FXK5-S6RWYAAAAC/hold-anime.gif','https://media.tenor.com/2FXK5-S6RWYAAAAC/hold-anime.gif'],
  pinch:      ['https://media.tenor.com/dU6qxAGsFZ4AAAAC/pinch-anime.gif','https://media.tenor.com/dU6qxAGsFZ4AAAAC/pinch-anime.gif'],
  carry:      ['https://media.tenor.com/I3m9HjpCGr8AAAAC/carry-anime.gif','https://media.tenor.com/I3m9HjpCGr8AAAAC/carry-anime.gif'],
  tickle:     ['https://media.tenor.com/ZGvpP8NWSYYAAAAC/tickle-anime.gif','https://media.tenor.com/ZGvpP8NWSYYAAAAC/tickle-anime.gif'],
  protect:    ['https://media.tenor.com/6eAa4Lp5mcEAAAAC/protect-anime.gif','https://media.tenor.com/6eAa4Lp5mcEAAAAC/protect-anime.gif'],
  miss:       ['https://media.tenor.com/sP74iWKuPgMAAAAC/miss-you-anime.gif','https://media.tenor.com/sP74iWKuPgMAAAAC/miss-you-anime.gif'],
};

// Templates
const TEMPLATES = {
  // [sender] → [target]
  hug:       (s,t) => `🤗 *${s}* hugged *${t}*! Feeling the warmth~ 💞`,
  kiss:      (s,t) => `💋 *${s}* kissed *${t}*! How sweet~ 😘`,
  slap:      (s,t) => `👋 *${s}* slapped *${t}*! THWACK!! 😤`,
  pat:       (s,t) => `🥺 *${s}* patted *${t}*'s head! Good good~ ✨`,
  poke:      (s,t) => `👉 *${s}* poked *${t}*! Hey! Stop ignoring me! 😤`,
  cuddle:    (s,t) => `🥰 *${s}* cuddled with *${t}*! So cozy~ 💕`,
  bite:      (s,t) => `😬 *${s}* bit *${t}*! Ouch! 🦷`,
  blush:     (s,t) => `😳 *${s}* is blushing because of *${t}*~ ❤️`,
  cry:       (s,t) => `😢 *${s}* is crying! Comfort them *${t}*! 💧`,
  dance:     (s,t) => `💃 *${s}* danced with *${t}*! Shake it! 🕺`,
  wave:      (s,t) => `👋 *${s}* waved at *${t}*! Hey there! ✨`,
  wink:      (s,t) => `😉 *${s}* winked at *${t}*! Cheeky~ 💫`,
  laugh:     (s,t) => `😂 *${s}* is laughing at *${t}*! Hahaha! 🤣`,
  smile:     (s,t) => `😊 *${s}* smiled at *${t}*! You made their day! 🌟`,
  angry:     (s,t) => `😠 *${s}* is angry at *${t}*! Watch out! 💢`,
  sad:       (s,t) => `😔 *${s}* is sad because of *${t}*... 💔`,
  scared:    (s,t) => `😱 *${s}* is scared of *${t}*! Help! 👻`,
  sleep:     (s,t) => `😴 *${s}* fell asleep! Someone wake them, *${t}*! 💤`,
  nod:       (s,t) => `👍 *${s}* nodded at *${t}*! Agreed! ✅`,
  nom:       (s,t) => `😋 *${s}* nommed on *${t}*! Tasty! 🍴`,
  lick:      (s,t) => `👅 *${s}* licked *${t}*! Ew... or cute? 😏`,
  punch:     (s,t) => `👊 *${s}* punched *${t}*! KO!! 💥`,
  kick:      (s,t) => `🦵 *${s}* kicked *${t}*! HYAH! ⚡`,
  throw:     (s,t) => `🤾 *${s}* threw *${t}*! YEET! 🌀`,
  shoot:     (s,t) => `🔫 *${s}* shot at *${t}*! Bang bang! 💀`,
  facepalm:  (s,t) => `🤦 *${s}* facepalmed because of *${t}*... 😩`,
  handshake: (s,t) => `🤝 *${s}* shook hands with *${t}*! Deal! ✨`,
  highfive:  (s,t) => `🙌 *${s}* high-fived *${t}*! Heck yeah! 🎉`,
  pout:      (s,t) => `😤 *${s}* is pouting at *${t}*! Hmph! 😾`,
  stare:     (s,t) => `👀 *${s}* is staring at *${t}*... Creepy! 👁️`,
  think:     (s,t) => `🤔 *${s}* is thinking about *${t}*~ 💭`,
  shrug:     (s,t) => `🤷 *${s}* shrugged at *${t}*! Whatever... 😶`,
  sigh:      (s,t) => `😮‍💨 *${s}* sighed at *${t}*... Here we go again 🌬️`,
  bored:     (s,t) => `😑 *${s}* is bored of *${t}*... Do something! 💤`,
  excited:   (s,t) => `🤩 *${s}* is excited about *${t}*! YAAAY! 🎊`,
  confused:  (s,t) => `😕 *${s}* is confused by *${t}*! Huh?? 🌀`,
  cheer:     (s,t) => `📣 *${s}* cheered for *${t}*! Go go go! 🎉`,
  yawn:      (s,t) => `🥱 *${s}* yawned! *${t}* is boring them 💤`,
  run:       (s,t) => `🏃 *${s}* is running from *${t}*! YEET!! 💨`,
  nosebleed: (s,t) => `🩸 *${s}* got a nosebleed from *${t}*! Too hot! 🔥`,
  faint:     (s,t) => `💫 *${s}* fainted because of *${t}*! They're too much! ✨`,
  celebrate: (s,t) => `🎊 *${s}* is celebrating with *${t}*! Woohoo! 🥳`,
  love:      (s,t) => `❤️ *${s}* loves *${t}*! Awww~ 💗`,
  kill:      (s,t) => `💀 *${s}* killed *${t}*! GG no re! ☠️`,
  feed:      (s,t) => `🍱 *${s}* is feeding *${t}*! Open wide! 😋`,
  hold:      (s,t) => `🤲 *${s}* is holding *${t}*! Don't let go~ 💞`,
  pinch:     (s,t) => `🤏 *${s}* pinched *${t}*! Ow! 😣`,
  carry:     (s,t) => `🏋️ *${s}* is carrying *${t}*! Weee! 🌟`,
  tickle:    (s,t) => `😂 *${s}* tickled *${t}*! Hahahaha stop! 🤣`,
  protect:   (s,t) => `🛡️ *${s}* is protecting *${t}*! Don't worry, I got you! 💪`,
  miss:      (s,t) => `💭 *${s}* misses *${t}*... Come back! 🥺`,
};

// All reaction command names
const REACTION_CMDS = Object.keys(GIFS);

// ── Pick a random GIF from the pool ─────────────────────────
function pickGif(type) {
  const pool = GIFS[type] || [];
  return pool[Math.floor(Math.random() * pool.length)] || null;
}

// ── Main reaction handler ────────────────────────────────────
// Returns true if handled, false otherwise
async function reactionHandler(sock, m, cmd, args, helpers) {
  if (!REACTION_CMDS.includes(cmd)) return false;

  const { reply, normNum } = helpers;
  const senderNum   = m.key.fromMe
    ? (sock.__waNum || normNum(sock.user?.id || ''))
    : normNum(m.key.participant || m.key.remoteJid);

  const senderName  = m.pushName || `@${senderNum}`;

  // Resolve target: mentioned, replied-to, or arg
  let targetNum  = null;
  let targetName = 'everyone';

  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid
    || m.message?.imageMessage?.contextInfo?.mentionedJid
    || [];

  if (mentioned.length) {
    targetNum  = normNum(mentioned[0]);
    targetName = `@${targetNum}`;
  } else if (m.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
    const ctx = m.message.extendedTextMessage.contextInfo;
    targetNum  = normNum(ctx.participant || ctx.remoteJid || '');
    targetName = `@${targetNum}`;
  } else if (args[0]) {
    targetName = args.join(' ');
  }

  const gifUrl   = pickGif(cmd);
  const template = TEMPLATES[cmd] || ((s, t) => `${s} did ${cmd} to ${t}`);
  const caption  = template(senderName, targetName);

  const mentions = [senderNum + '@s.whatsapp.net'];
  if (targetNum) mentions.push(targetNum + '@s.whatsapp.net');

  try {
    if (gifUrl) {
      const res = await axios.get(gifUrl, { responseType: 'arraybuffer', timeout: 10000 });
      await sock.sendMessage(m.key.remoteJid, {
        video:    Buffer.from(res.data),
        gifPlayback: true,
        caption,
        mentions,
      }, {});
    } else {
      await sock.sendMessage(m.key.remoteJid, { text: caption, mentions }, {});
    }
  } catch {
    // GIF failed, send text
    try {
      await sock.sendMessage(m.key.remoteJid, { text: caption, mentions }, {});
    } catch {}
  }

  return true;
}

module.exports = { reactionHandler};
