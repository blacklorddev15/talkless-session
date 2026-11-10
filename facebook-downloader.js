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
function box(title, text) { return `${title}\n${text}`; }
async function reply(sock, jid, msg, payload) {
  if (typeof payload === 'string') return sock.sendMessage(jid, { text: payload }, {});
  return sock.sendMessage(jid, payload, {});
}
function friendlyDownloadError(error, label) { return `${label} download failed: ${error?.message || 'unknown error'}`; }

const FBURL_COMMANDS = ['fb', 'facebook'];
function sessionStateKey(sock, jid) {
    const pair = String(sock?.__waNum || sock?.user?.id || '').replace(/\D/g, '');
    return `${pair}:${jid}`;
}

const pendingFburl = new Map();

function isFacebookLink(text) {
    return /^https?:\/\/(www\.|m\.|web\.|mbasic\.|fb\.watch)/i.test(text) && /facebook\.com|fb\.watch/i.test(text);
}

function toMbasicUrl(inputUrl) {
    try {
        const parsed = new URL(inputUrl);
        if (/fb\.watch$/i.test(parsed.hostname)) return inputUrl;
        parsed.hostname = 'mbasic.facebook.com';
        return parsed.toString();
    } catch (_) {
        return inputUrl;
    }
}

function httpGet(targetUrl, redirectCount = 0) {
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
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': 'locale=en_US'
            }
        };
        const req = https.request(options, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const nextUrl = new URL(res.headers.location, targetUrl).toString();
                resolve(httpGet(nextUrl, redirectCount + 1));
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
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

function httpHead(targetUrl, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 8) {
            reject(new Error('Too many redirects'));
            return;
        }
        const parsed = new URL(targetUrl);
        const options = {
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            }
        };
        const req = https.request(options, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const nextUrl = new URL(res.headers.location, targetUrl).toString();
                resolve(httpHead(nextUrl, redirectCount + 1));
                return;
            }
            res.resume();
            resolve({ statusCode: res.statusCode, headers: res.headers });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
        req.end();
    });
}

function httpRangeProbe(targetUrl, redirectCount = 0) {
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
                'Accept': '*/*',
                'Range': 'bytes=0-0'
            }
        };
        const req = https.request(options, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                req.destroy();
                const nextUrl = new URL(res.headers.location, targetUrl).toString();
                resolve(httpRangeProbe(nextUrl, redirectCount + 1));
                return;
            }
            const headers = res.headers;
            const statusCode = res.statusCode;
            res.destroy();
            req.destroy();
            resolve({ statusCode, headers });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
        req.end();
    });
}

function bytesToMbLabel(bytes) {
    const mb = Number(bytes) / (1024 * 1024);
    if (!(mb > 0)) return null;
    return mb.toFixed(mb < 10 ? 2 : 1) + ' MB';
}

async function getSizeLabel(fileUrl) {
    try {
        const head = await httpHead(fileUrl);
        const len = head.headers && head.headers['content-length'];
        const label = len ? bytesToMbLabel(len) : null;
        if (label) return label;
    } catch (_) {}

    try {
        const probe = await httpRangeProbe(fileUrl);
        const contentRange = probe.headers && probe.headers['content-range'];
        if (contentRange) {
            const total = contentRange.split('/')[1];
            const label = total ? bytesToMbLabel(total) : null;
            if (label) return label;
        }
        const len = probe.headers && probe.headers['content-length'];
        if (probe.statusCode === 200 && len) {
            const label = bytesToMbLabel(len);
            if (label) return label;
        }
    } catch (_) {}

    return null;
}

async function extractAudioFromVideoBuffer(videoBuffer) {
    const tempDir = os.tmpdir();
    const id = crypto.randomBytes(6).toString('hex');
    const inputPath = path.join(tempDir, 'fburl_' + id + '.mp4');
    const outputPath = path.join(tempDir, 'fburl_' + id + '.m4a');

    await fs.writeFile(inputPath, videoBuffer);

    try {
        try {
            await execFileAsync(ffmpegPath, ['-i', inputPath, '-vn', '-acodec', 'copy', '-y', outputPath]);
        } catch (_) {
            await execFileAsync(ffmpegPath, ['-i', inputPath, '-vn', '-acodec', 'aac', '-b:a', '128k', '-y', outputPath]);
        }
        return await fs.readFile(outputPath);
    } finally {
        await fs.unlink(inputPath).catch(() => {});
        await fs.unlink(outputPath).catch(() => {});
    }
}

function unescapeUrl(value) {
    return value.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

async function scrapeFacebookQualities(postUrl) {
    const targets = [postUrl, toMbasicUrl(postUrl)];

    for (const target of targets) {
        let pageResponse;
        try {
            pageResponse = await httpGet(target);
        } catch (_) {
            continue;
        }
        if (pageResponse.statusCode !== 200) continue;

        const html = pageResponse.body.toString('utf-8');

        if (/content isn't available|this content is not available|login to continue/i.test(html)) {
            throw new Error('This video is private, deleted, or requires login to view');
        }

        const qualities = {};

        const hdMatch = html.match(/"browser_native_hd_url":"([^"]+)"/i);
        if (hdMatch) qualities['HD'] = unescapeUrl(hdMatch[1]);

        const sdMatch = html.match(/"browser_native_sd_url":"([^"]+)"/i);
        if (sdMatch) qualities['SD'] = unescapeUrl(sdMatch[1]);

        if (!hdMatch && !sdMatch) {
            const ogMatch = html.match(/<meta property="og:video(?::url)?" content="([^"]+)"/i);
            if (ogMatch) qualities['Standard'] = unescapeUrl(ogMatch[1]);
        }

        const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);

        if (Object.keys(qualities).length) {
            return { qualities, title: titleMatch ? unescapeUrl(titleMatch[1]) : '' };
        }
    }

    return null;
}

async function fetchFacebookViaSankavollerei(url) {
    try {
        const apiUrl = `https://www.sankavollerei.web.id/download/facebook?apikey=planaai&url=${encodeURIComponent(url)}`;
        const response = await fetch(apiUrl, { timeout: 15000 });
        if (!response.ok) return null;
        const data = await response.json();

        if (data.status && data.result) {
            const mediaUrl = data.result.media;
            const title = data.result.title || 'Facebook Video';
            const qualities = {};

            const videos = Array.isArray(data.result.video)
                ? data.result.video
                : (Array.isArray(data.result.videos) ? data.result.videos : []);
            videos.forEach(video => {
                const link = video?.url || video?.download || video?.link;
                if (link) qualities[video.quality || video.label || `Quality ${Object.keys(qualities).length + 1}`] = link;
            });

            if (Array.isArray(mediaUrl)) {
                mediaUrl.forEach((item, index) => {
                    const link = typeof item === 'string' ? item : (item?.url || item?.download || item?.link);
                    if (link) qualities[item?.quality || item?.label || `Quality ${index + 1}`] = link;
                });
            }

            if (typeof mediaUrl === 'string' && !Object.keys(qualities).length) {
                qualities['Direct CDN'] = mediaUrl;
            }

            return {
                title: title,
                qualities: qualities,
                thumbnail: data.result.thumbnail
            };
        }
    } catch (error) {
        return null;
    }
    return null;
}

async function fetchFacebookViaApi(url) {
    try {
        const response = await fetch(`https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(url)}`, { timeout: 12000 });
        if (!response.ok) throw new Error(`Facebook Siputzx returned HTTP ${response.status}`);
        const r = await response.json();
        const downloads = Array.isArray(r?.data?.downloads) ? r.data.downloads : [];
        const preferred = downloads.find(item => /hd|720/i.test(item?.quality || '')) || downloads[0];
        const link = preferred?.url || r?.data?.url || r?.data?.hd || r?.data?.sd || r?.data?.download?.url;
        const title = r?.data?.title;
        if (link) return { link, title };
    } catch (_) {}
    try {
        const response = await fetch(`https://api-faa.my.id/faa/fbdl?url=${encodeURIComponent(url)}`, { timeout: 10000 });
        if (!response.ok) throw new Error(`Facebook FAA returned HTTP ${response.status}`);
        const r = await response.json();
        const link = r?.result?.hd || r?.result?.sd || r?.result?.download;
        const title = r?.result?.title;
        if (link) return { link, title };
    } catch (_) {}
    try {
        const response = await fetch(`https://api.azbry.com/api/download/fb?url=${encodeURIComponent(url)}`, { timeout: 10000 });
        if (!response.ok) throw new Error(`Facebook Azbry returned HTTP ${response.status}`);
        const r = await response.json();
        const link = r?.result?.download || r?.result?.url;
        const title = r?.result?.title;
        if (link) return { link, title };
    } catch (_) {}
    return null;
}

async function resolveFacebookMedia(inputUrl) {
    const viaSankavollerei = await fetchFacebookViaSankavollerei(inputUrl);
    if (viaSankavollerei && Object.keys(viaSankavollerei.qualities).length) {
        return { qualities: viaSankavollerei.qualities, title: viaSankavollerei.title };
    }

    const scraped = await scrapeFacebookQualities(inputUrl);
    if (scraped && Object.keys(scraped.qualities).length) {
        return { qualities: scraped.qualities, title: scraped.title };
    }

    const apiResult = await fetchFacebookViaApi(inputUrl);
    if (apiResult && apiResult.link) {
        return { qualities: { 'Standard': apiResult.link }, title: apiResult.title || 'Facebook Video' };
    }

    return null;
}

function isPendingFburlRequest(sock, jid) {
    return pendingFburl.has(sessionStateKey(sock, jid));
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
    const buttons = [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Video', id: 'fburl_type_video' }) },
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Audio', id: 'fburl_type_audio' }) }
    ];
    await sendNativeFlow(sock, jid, msg, 'Do you want to download Video or Audio?', buttons);
}

async function sendQualityButtons(sock, jid, msg, items) {
    const buttons = items.map(item => ({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text: item.label, id: 'fburl_q_' + item.id })
    }));
    await sendNativeFlow(sock, jid, msg, 'Select quality:', buttons);
}

async function downloadAndSend(sock, jid, msg, type, fileUrl, title, qualityLabel) {
    await reply(sock, jid, msg, `𝐓𝐀𝐋𝐊𝐋𝐄𝐒𝐒 𝐒𝐎𝐂𝐈𝐀𝐋 𝐒𝐘𝐒𝐓𝐄𝐌𝐒 𝐅𝐄𝐓𝐂𝐇𝐈𝐍𝐆 ${type.toUpperCase()}`);

    const fileResult = await httpGet(fileUrl);
    if (fileResult.statusCode !== 200) throw new Error('Download returned status ' + fileResult.statusCode);

    if (type === 'audio') {
        const audioBuffer = await extractAudioFromVideoBuffer(fileResult.body);
        await reply(sock, jid, msg, {
            audio: audioBuffer,
            mimetype: 'audio/mp4',
            caption: box('FACEBOOK DOWNLOAD', (title || 'Facebook Video') + '\nQuality: ' + qualityLabel)
        });
    } else {
        await reply(sock, jid, msg, {
            video: fileResult.body,
            mimetype: 'video/mp4',
            caption: box('FACEBOOK DOWNLOAD', (title || 'Facebook Video') + '\nQuality: ' + qualityLabel)
        });
    }
}

async function handlePendingFburlReply(sock, jid, msg, text) {
    if (!pendingFburl.has(sessionStateKey(sock, jid))) return false;

    const buttonId = extractButtonReplyId(msg);
    const rawText = (text || '').trim();
    const isCommandAttempt = !buttonId && /^[.\/!#]/.test(rawText);
    const entry = pendingFburl.get(sessionStateKey(sock, jid));

    if (entry.stage === 'type') {
        let choice = null;
        if (buttonId === 'fburl_type_video') choice = 'video';
        else if (buttonId === 'fburl_type_audio') choice = 'audio';
        else if (!buttonId) {
            const t = rawText.replace(/^[.\/!#]+/, '').trim().toLowerCase();
            if (t === 'video') choice = 'video';
            else if (t === 'audio') choice = 'audio';
        }

        if (!choice) {
            if (isCommandAttempt) return false;
            await reply(sock, jid, msg, box('FACEBOOK DOWNLOAD', 'Please select Video or Audio.'));
            return true;
        }

        const qualityNames = Object.keys(entry.qualities).slice(0, 3);

        if (qualityNames.length <= 1) {
            pendingFburl.delete(sessionStateKey(sock, jid));
            const onlyKey = qualityNames[0];
            try {
                await downloadAndSend(sock, jid, msg, choice, entry.qualities[onlyKey], entry.title, onlyKey);
            } catch (error) {
                await reply(sock, jid, msg, box('FACEBOOK DOWNLOAD', friendlyDownloadError(error, 'Facebook video')));
            }
            return true;
        }

        await reply(sock, jid, msg, box('FACEBOOK DOWNLOAD', 'Checking available qualities, please wait...'));

        const sizedQualities = {};
        const buttonItems = [];
        for (const name of qualityNames) {
            const size = await getSizeLabel(entry.qualities[name]);
            sizedQualities[name] = entry.qualities[name];
            buttonItems.push({ id: name, label: name + (size ? ' - ' + size : '') });
        }

        pendingFburl.set(sessionStateKey(sock, jid), { stage: 'quality', type: choice, qualities: sizedQualities, title: entry.title });

        const infoLines = [
            'Title: ' + (entry.title || 'Facebook Video'),
            '',
            'Available qualities: ' + buttonItems.map(item => item.label).join(', ')
        ].join('\n');

        await reply(sock, jid, msg, box('FACEBOOK DOWNLOAD', infoLines));
        await sendQualityButtons(sock, jid, msg, buttonItems);
        return true;
    }

    if (entry.stage === 'quality') {
        let trimmed;
        if (buttonId) {
            trimmed = buttonId.startsWith('fburl_q_') ? buttonId.slice('fburl_q_'.length) : buttonId;
        } else {
            trimmed = rawText.replace(/^[.\/!#]+/, '').trim();
        }

        if (!trimmed) return false;

        const choiceLower = trimmed.toLowerCase();
        const matchedKey = Object.keys(entry.qualities).find(q => q.toLowerCase() === choiceLower);

        if (!matchedKey) {
            if (isCommandAttempt) return false;
            await reply(sock, jid, msg, box('FACEBOOK DOWNLOAD', 'Please select a valid quality: ' + Object.keys(entry.qualities).join(', ')));
            return true;
        }

        pendingFburl.delete(sessionStateKey(sock, jid));
        try {
            await downloadAndSend(sock, jid, msg, entry.type, entry.qualities[matchedKey], entry.title, matchedKey);
        } catch (error) {
            await reply(sock, jid, msg, box('FACEBOOK DOWNLOAD', friendlyDownloadError(error, 'Facebook video')));
        }
        return true;
    }

    return false;
}

async function handleFburlCommand(sock, jid, msg, command, params) {
  if (!['fb', 'facebook'].includes(command)) return false;
  const inputUrl = extractUrl(params[0] || '') || (params[0] || '').trim();
  if (!inputUrl) { await reply(sock, jid, msg, box('FACEBOOK DOWNLOAD', 'Send a Facebook video link with the command.')); return true; }
  if (!isFacebookLink(inputUrl)) { await reply(sock, jid, msg, box('FACEBOOK DOWNLOAD', 'This does not look like a valid Facebook link.')); return true; }
        await reply(sock, jid, msg, '𝐓𝐀𝐋𝐊𝐋𝐄𝐒𝐒 𝐒𝐎𝐂𝐈𝐀𝐋 𝐒𝐘𝐒𝐓𝐄𝐌𝐒 𝐅𝐄𝐓𝐂𝐇𝐈𝐍𝐆 MEDIA');
  try {
    const media = await resolveFacebookMedia(inputUrl);
    if (!media || !Object.keys(media.qualities || {}).length) throw new Error('Could not find downloadable media');
    const names = Object.keys(media.qualities);
    if (names.length === 1) {
      pendingFburl.set(sessionStateKey(sock, jid), { stage: 'type', qualities: media.qualities, title: media.title });
      await sendTypeButtons(sock, jid, msg);
      return true;
    }
    pendingFburl.set(sessionStateKey(sock, jid), { stage: 'type', qualities: media.qualities, title: media.title });
    await sendTypeButtons(sock, jid, msg);
  } catch (error) {
    await reply(sock, jid, msg, box('FACEBOOK DOWNLOAD', friendlyDownloadError(error, 'Facebook post')));
  }
  return true;
}

module.exports = { handleFburlCommand, FBURL_COMMANDS, isPendingFburlRequest, handlePendingFburlReply };
