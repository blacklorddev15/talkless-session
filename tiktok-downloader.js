'use strict';
const https = require('https');
const getBaileys = async () => require('blacklord-baileys');
const fetch = global.fetch;
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const { URL } = require('url');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const SANKA_APIKEY = 'planaai';
const VIDEO_QUALITIES = ['HD', 'No Watermark', 'Watermark'];
function sessionStateKey(sock, jid) {
    const pair = String(sock?.__waNum || sock?.user?.id || '').replace(/\D/g, '');
    return `${pair}:${jid}`;
}

const pendingType = new Map();
const pendingQuality = new Map();
const TTURL_COMMANDS = ['tkdl', 'tiktok', 'tt'];
function box(title, text) { return `${title}\n${text}`; }
async function reply(sock, jid, msg, payload) {
  if (typeof payload === 'string') return sock.sendMessage(jid, { text: payload }, {});
  return sock.sendMessage(jid, payload, {});
}
function friendlyDownloadError(error, label) { return `${label} download failed: ${error?.message || 'unknown error'}`; }

function isTiktokLink(text) {
    return /^https?:\/\/(www\.|vm\.|vt\.|m\.)?tiktok\.com\//i.test(text);
}

function extractUrl(str) {
    const match = (str || '').match(/https?:\/\/[^\s]+/gi);
    return match ? match[0] : null;
}

function httpGetJson(targetUrl) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(targetUrl);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                } catch (e) {
                    reject(new Error('Invalid response from TikTok service'));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
        req.end();
    });
}

function httpDownload(targetUrl, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 8) {
            reject(new Error('Too many redirects'));
            return;
        }
        const parsed = new URL(targetUrl);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.tikwm.com/'
            }
        };
        const req = https.request(options, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const nextUrl = new URL(res.headers.location, targetUrl).toString();
                resolve(httpDownload(nextUrl, redirectCount + 1));
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Download timed out'));
        });
        req.end();
    });
}

async function fetchTiktokInfoViaTikwm(url) {
    try {
        const apiUrl = 'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1';
        const apiResponse = await httpGetJson(apiUrl);
        if (apiResponse && apiResponse.code === 0 && apiResponse.data) {
            return apiResponse.data;
        }
    } catch (_) {}
    return null;
}

async function fetchTiktokInfoViaSankavollerei(url) {
    const endpoints = [
        'https://www.sankavollerei.web.id/download/tiktok?apikey=' + SANKA_APIKEY + '&url=',
        'https://www.sankavollerei.web.id/download/tiktok-hd?apikey=' + SANKA_APIKEY + '&url=',
        'https://www.sankavollerei.web.id/download/tiktok-v2?apikey=' + SANKA_APIKEY + '&url='
    ];

    for (const base of endpoints) {
        try {
            const r = await httpGetJson(base + encodeURIComponent(url));
            if (r && r.status === false) continue;

            const result = r?.result || r?.data;
            if (!result) continue;

            const normalized = {
                title: result.title || result.desc || result.description || result.caption || 'TikTok Video',
                author: {
                    nickname: result.author?.nickname || result.author?.name || result.author || result.username || 'Unknown'
                },
                images: Array.isArray(result.images) ? result.images
                    : (Array.isArray(result.slideshow) ? result.slideshow
                    : (Array.isArray(result.slides) ? result.slides : [])),
                music: result.music || result.audio || result.mp3,
                play: result.play || result.no_watermark || result.nowm || result.video,
                wmplay: result.wmplay || result.watermark,
                hdplay: result.hdplay || result.hd
            };

            if (normalized.play || normalized.wmplay || normalized.hdplay || normalized.images.length) {
                return normalized;
            }
        } catch (_) {}
    }

    return null;
}

async function fetchTiktokInfo(url) {
    const viaTikwm = await fetchTiktokInfoViaTikwm(url);
    if (viaTikwm) return viaTikwm;
    const viaSanka = await fetchTiktokInfoViaSankavollerei(url);
    if (viaSanka) return viaSanka;

    throw new Error('Could not fetch this TikTok post');
}

function pickVideoLink(data, quality) {
    if (quality === 'HD') return data.hdplay || data.play || data.wmplay;
    if (quality === 'No Watermark') return data.play || data.hdplay || data.wmplay;
    return data.wmplay || data.play || data.hdplay;
}

function isPendingTturlRequest(sock, jid) {
    return pendingType.has(sessionStateKey(sock, jid)) || pendingQuality.has(sessionStateKey(sock, jid));
}

function extractButtonReplyId(msg) {
    try {
        const nfr = msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage;
        if (nfr && nfr.paramsJson) {
            const parsed = JSON.parse(nfr.paramsJson);
            if (parsed && parsed.id) return String(parsed.id);
        }
    } catch {}
    try {
        const buttonId = msg.message?.buttonsResponseMessage?.selectedButtonId
            || msg.message?.templateButtonReplyMessage?.selectedId
            || msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
        if (buttonId) return String(buttonId);
    } catch {}
    return null;
}

async function sendNativeFlow(sock, jid, msg, bodyText, buttons) {
    try {
        const { generateWAMessageFromContent, proto } = await getBaileys();

        const interactiveMsg = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        contextInfo: {  },
                        body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons })
                    })
                }
            }
        }, { userJid: sock.user.id });

        await sock.relayMessage(jid, interactiveMsg.message, {
            messageId: interactiveMsg.key.id,
            additionalNodes: [
                {
                    tag: 'biz',
                    attrs: {},
                    content: [
                        {
                            tag: 'interactive',
                            attrs: { type: 'native_flow', v: '1' },
                            content: [{ tag: 'native_flow', attrs: { name: 'mixed', v: '9' } }]
                        }
                    ]
                }
            ]
        });
        return true;
    } catch {
        return false;
    }
}

async function sendTypeButtons(sock, jid, msg) {
    await sendNativeFlow(sock, jid, msg, 'Tap what you want to download:', [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🎧 Audio', id: 'tturl_type_audio' }) },
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🎬 Video', id: 'tturl_type_video' }) }
    ]);
}

async function sendQualityButtons(sock, jid, msg, qualities) {
    const buttons = qualities.map(q => ({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text: q, id: 'tturl_q_' + q.replace(/\s+/g, '_') })
    }));
    await sendNativeFlow(sock, jid, msg, 'Select quality:', buttons);
}

async function handlePendingTturlReply(sock, jid, msg, text) {
    const buttonId = extractButtonReplyId(msg);
    const rawText = (text || '').trim();
    const isCommandAttempt = !buttonId && /^[.\/!#]/.test(rawText);
    let trimmed;

    if (buttonId) {
        if (buttonId.startsWith('tturl_type_')) trimmed = buttonId.slice('tturl_type_'.length);
        else if (buttonId.startsWith('tturl_q_')) trimmed = buttonId.slice('tturl_q_'.length).replace(/_/g, ' ');
        else trimmed = buttonId;
    } else {
        trimmed = rawText.replace(/^[.\/!#]+/, '').trim();
    }

    if (!trimmed) return false;

    if (pendingQuality.has(sessionStateKey(sock, jid))) {
        const entry = pendingQuality.get(sessionStateKey(sock, jid));
        const choice = trimmed.toLowerCase();
        const matched = VIDEO_QUALITIES.find(q => q.toLowerCase() === choice);

        if (!matched) {
            if (isCommandAttempt) return false;
            await reply(sock, jid, msg, box('TIKTOK DOWNLOAD', 'Please select a valid quality: ' + VIDEO_QUALITIES.join(', ')));
            return true;
        }

        pendingQuality.delete(sessionStateKey(sock, jid));
        await reply(sock, jid, msg, '𝐓𝐀𝐋𝐊𝐋𝐄𝐒𝐒 𝐒𝐎𝐂𝐈𝐀𝐋 𝐒𝐘𝐒𝐓𝐄𝐌𝐒 𝐅𝐄𝐓𝐂𝐇𝐈𝐍𝐆 VIDEO');

        try {
            const videoUrl = pickVideoLink(entry.data, matched);
            if (!videoUrl) throw new Error('No downloadable video found.');
            const videoResult = await httpDownload(videoUrl);
            if (videoResult.statusCode !== 200) throw new Error('Video download returned status ' + videoResult.statusCode);

            await reply(sock, jid, msg, {
                video: videoResult.body,
                mimetype: 'video/mp4',
                caption: box('TIKTOK DOWNLOAD', (entry.data.title || 'TikTok Video') + '\nQuality: ' + matched)
            });
        } catch (error) {
            await reply(sock, jid, msg, box('TIKTOK DOWNLOAD', friendlyDownloadError(error, 'TikTok video')));
        }
        return true;
    }

    if (pendingType.has(sessionStateKey(sock, jid))) {
        const entry = pendingType.get(sessionStateKey(sock, jid));
        const choice = trimmed.toLowerCase();

        if (choice !== 'audio' && choice !== 'video') {
            if (isCommandAttempt) return false;
            await reply(sock, jid, msg, box('TIKTOK DOWNLOAD', 'Please reply with: audio or video.'));
            return true;
        }

        pendingType.delete(sessionStateKey(sock, jid));

        if (choice === 'audio') {
            await reply(sock, jid, msg, '𝐓𝐀𝐋𝐊𝐋𝐄𝐒𝐒 𝐒𝐎𝐂𝐈𝐀𝐋 𝐒𝐘𝐒𝐓𝐄𝐌𝐒 𝐅𝐄𝐓𝐂𝐇𝐈𝐍𝐆 AUDIO');
            try {
                const musicUrl = entry.data.music;
                if (!musicUrl) throw new Error('No downloadable audio found.');
                const audioResult = await httpDownload(musicUrl);
                if (audioResult.statusCode !== 200) throw new Error('Audio download returned status ' + audioResult.statusCode);

                await reply(sock, jid, msg, {
                    audio: audioResult.body,
                    mimetype: 'audio/mpeg',
                    fileName: (entry.data.title || 'TikTok') + '.mp3'
                });
            } catch (error) {
                await reply(sock, jid, msg, box('TIKTOK DOWNLOAD', friendlyDownloadError(error, 'TikTok audio')));
            }
            return true;
        }

        pendingQuality.set(sessionStateKey(sock, jid), { data: entry.data });
        await reply(sock, jid, msg, box('TIKTOK DOWNLOAD', 'Choose quality:'));
        await sendQualityButtons(sock, jid, msg, VIDEO_QUALITIES);
        return true;
    }

    return false;
}

async function handleTturlCommand(sock, jid, msg, command, params, sender, senderIsOwner) {
    switch (command) {
        case 'tkdl':
        case 'tiktok':
        case 'tt': {
            const inputUrl = extractUrl(params[0] || '') || (params[0] || '').trim();

            if (!inputUrl) {
                await reply(sock, jid, msg, box('TIKTOK DOWNLOAD', 'Send a TikTok link with the command.\nExample: .tturl https://vt.tiktok.com/xxxxxxx'));
                break;
            }

            if (!isTiktokLink(inputUrl)) {
                await reply(sock, jid, msg, box('TIKTOK DOWNLOAD', 'This does not look like a valid TikTok link.'));
                break;
            }

            await reply(sock, jid, msg, '𝐓𝐀𝐋𝐊𝐋𝐄𝐒𝐒 𝐒𝐎𝐂𝐈𝐀𝐋 𝐒𝐘𝐒𝐓𝐄𝐌𝐒 𝐅𝐄𝐓𝐂𝐇𝐈𝐍𝐆 MEDIA');

            try {
                const data = await fetchTiktokInfo(inputUrl);

                if (Array.isArray(data.images) && data.images.length > 0) {
                    for (let i = 0; i < data.images.length; i++) {
                        const imageResult = await httpDownload(data.images[i]);
                        if (imageResult.statusCode !== 200) continue;
                        await reply(sock, jid, msg, {
                            image: imageResult.body,
                            caption: i === 0 ? box('TIKTOK DOWNLOAD', (data.title || 'TikTok slideshow') + '\nImage ' + (i + 1) + ' of ' + data.images.length) : ''
                        });
                    }
                    break;
                }

                const videoUrl = pickVideoLink(data, 'No Watermark');
                if (!videoUrl) throw new Error('No downloadable video found.');
                await reply(sock, jid, msg, '𝐓𝐀𝐋𝐊𝐋𝐄𝐒𝐒 𝐒𝐎𝐂𝐈𝐀𝐋 𝐒𝐘𝐒𝐓𝐄𝐌𝐒 𝐅𝐄𝐓𝐂𝐇𝐈𝐍𝐆 VIDEO');
                const videoResult = await httpDownload(videoUrl);
                if (videoResult.statusCode !== 200) throw new Error('Video download returned status ' + videoResult.statusCode);
                await reply(sock, jid, msg, {
                    video: videoResult.body,
                    mimetype: 'video/mp4',
                    caption: box('TIKTOK DOWNLOAD', data.title || 'TikTok Video')
                });
            } catch (error) {
                await reply(sock, jid, msg, box('TIKTOK DOWNLOAD', friendlyDownloadError(error, 'TikTok post')));
            }
            break;
        }
    }
}

module.exports = {
    handleTturlCommand,
    TTURL_COMMANDS,
    isPendingTturlRequest,
    handlePendingTturlReply
};
