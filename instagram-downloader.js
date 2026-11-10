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

const IGURL_COMMANDS = ['ig', 'instagram'];
function sessionStateKey(sock, jid) {
    const pair = String(sock?.__waNum || sock?.user?.id || '').replace(/\D/g, '');
    return `${pair}:${jid}`;
}

const pendingIgurl = new Map();

function extractUrl(str) {
    const match = (str || '').match(/https?:\/\/[^\s]+/gi);
    return match ? match[0] : null;
}

function isInstagramLink(text) {
    return /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[a-zA-Z0-9_-]+/i.test(text);
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
                'Accept-Language': 'en-US,en;q=0.9'
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

function unescapeUrl(value) {
    return value.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
}

async function extractAudioFromVideoBuffer(videoBuffer) {
    const tempDir = os.tmpdir();
    const id = crypto.randomBytes(6).toString('hex');
    const inputPath = path.join(tempDir, 'igurl_' + id + '.mp4');
    const outputPath = path.join(tempDir, 'igurl_' + id + '.m4a');

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

function extractCarouselItems(html) {
    const items = [];
    const sidecarMatch = html.match(/"edge_sidecar_to_children":\{"edges":(\[[\s\S]*?\])\}/);
    if (!sidecarMatch) return items;

    try {
        const edges = JSON.parse(sidecarMatch[1]);
        for (const edge of edges) {
            const node = edge?.node;
            if (!node) continue;
            if (node.is_video && node.video_url) {
                items.push({ type: 'video', url: node.video_url });
            } else if (node.display_url) {
                items.push({ type: 'image', url: node.display_url });
            }
        }
    } catch (_) {}

    return items;
}

async function scrapeInstagramMedia(postUrl) {
    let pageResponse;
    try {
        pageResponse = await httpGet(postUrl);
    } catch (_) {
        return null;
    }
    if (pageResponse.statusCode !== 200) return null;

    const html = pageResponse.body.toString('utf-8');

    if (/Page Not Found|content isn't available|login to continue/i.test(html)) {
        throw new Error('This post is private, deleted, or requires login to view');
    }

    const carouselItems = extractCarouselItems(html);
    if (carouselItems.length > 1) {
        return { type: 'carousel', items: carouselItems };
    }

    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i)
        || html.match(/<meta property="og:description" content="([^"]+)"/i);
    const title = titleMatch ? unescapeUrl(titleMatch[1]) : '';

    const videoMatch = html.match(/<meta property="og:video" content="([^"]+)"/i)
        || html.match(/"video_url":"([^"]+)"/i);
    if (videoMatch) {
        return { type: 'video', url: unescapeUrl(videoMatch[1]), title };
    }

    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
    if (imageMatch) {
        return { type: 'image', url: unescapeUrl(imageMatch[1]), title };
    }

    return null;
}

async function fetchInstagramViaSankavollerei(postUrl) {
    try {
        const apiUrl = `https://www.sankavollerei.web.id/download/instagram?apikey=planaai&url=${encodeURIComponent(postUrl)}`;
        const response = await fetch(apiUrl, { timeout: 15000 });
        if (!response.ok) return null;
        const data = await response.json();

        if (!data.status || !data.result || !Array.isArray(data.result.media) || !data.result.media.length) {
            return null;
        }

        const title = data.result.caption || 'Instagram Video';
        const media = data.result.media;

        if (media.length > 1) {
            const items = media.map(item => {
                const looksVideo = /type=video/i.test(item.url) || item.type === 'video';
                return { type: looksVideo ? 'video' : 'image', url: item.url };
            });
            return { type: 'carousel', items, title };
        }

        const single = media[0];
        const looksVideo = /type=video/i.test(single.url) || single.type === 'video' || /\/(reel|reels|tv)\//i.test(postUrl);

        if (looksVideo) {
            return { type: 'video', url: single.url, title };
        }

        return { type: 'image', url: single.url, title };
    } catch (_) {}
    return null;
}

async function fetchInstagramViaSiputzx(url) {
    try {
        const apiUrl = `https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`;
        const response = await fetch(apiUrl, { timeout: 10000 });
        if (!response.ok) return null;
        const data = await response.json();

        const items = Array.isArray(data?.data) ? data.data : (data?.data ? [data.data] : []);
        if (!items.length) return null;

        const link = items[0]?.url || items[0]?.download_url;
        if (!link) return null;

        return { type: 'video', url: link, title: items[0]?.title || items[0]?.caption || 'Instagram Video' };
    } catch (_) {}
    return null;
}

async function fetchInstagramViaApi(url) {
    try {
        const response = await fetch(`https://api-faa.my.id/faa/igdl?url=${encodeURIComponent(url)}`, { timeout: 10000 });
        if (!response.ok) throw new Error(`Instagram FAA returned HTTP ${response.status}`);
        const r = await response.json();
        const link = r?.result?.hd || r?.result?.sd || r?.result?.download || r?.result?.url;
        const title = r?.result?.title;
        if (link) return { link, title };
    } catch (_) {}
    try {
        const response = await fetch(`https://api.azbry.com/api/download/ig?url=${encodeURIComponent(url)}`, { timeout: 10000 });
        if (!response.ok) throw new Error(`Instagram Azbry returned HTTP ${response.status}`);
        const r = await response.json();
        const link = r?.result?.download || r?.result?.url;
        const title = r?.result?.title;
        if (link) return { link, title };
    } catch (_) {}
    return null;
}

async function resolveInstagramMedia(inputUrl) {
    const scraped = await scrapeInstagramMedia(inputUrl);
    if (scraped) return scraped;

    const viaSankavollerei = await fetchInstagramViaSankavollerei(inputUrl);
    if (viaSankavollerei) return viaSankavollerei;

    const viaSiputzx = await fetchInstagramViaSiputzx(inputUrl);
    if (viaSiputzx) return viaSiputzx;

    const apiResult = await fetchInstagramViaApi(inputUrl);
    if (apiResult && apiResult.link) {
        return { type: 'video', url: apiResult.link, title: apiResult.title || 'Instagram Video' };
    }

    return null;
}

function isPendingIgurlRequest(sock, jid) {
    return pendingIgurl.has(sessionStateKey(sock, jid));
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
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Video', id: 'igurl_type_video' }) },
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Audio', id: 'igurl_type_audio' }) }
    ];
    await sendNativeFlow(sock, jid, msg, 'Do you want to download Video or Audio?', buttons);
}

async function downloadAndSend(sock, jid, msg, type, fileUrl, title) {
    await reply(sock, jid, msg, `𝐓𝐀𝐋𝐊𝐋𝐄𝐒𝐒 𝐒𝐎𝐂𝐈𝐀𝐋 𝐒𝐘𝐒𝐓𝐄𝐌𝐒 𝐅𝐄𝐓𝐂𝐇𝐈𝐍𝐆 ${type.toUpperCase()}`);

    const fileResult = await httpGet(fileUrl);
    if (fileResult.statusCode !== 200) throw new Error('Download returned status ' + fileResult.statusCode);

    if (type === 'audio') {
        const audioBuffer = await extractAudioFromVideoBuffer(fileResult.body);
        await reply(sock, jid, msg, {
            audio: audioBuffer,
            mimetype: 'audio/mp4',
            caption: box('INSTAGRAM DOWNLOAD', title || 'Instagram Video')
        });
    } else {
        await reply(sock, jid, msg, {
            video: fileResult.body,
            mimetype: 'video/mp4',
            caption: box('INSTAGRAM DOWNLOAD', title || 'Instagram Video')
        });
    }
}

async function handlePendingIgurlReply(sock, jid, msg, text) {
    if (!pendingIgurl.has(sessionStateKey(sock, jid))) return false;

    const buttonId = extractButtonReplyId(msg);
    const rawText = (text || '').trim();
    const isCommandAttempt = !buttonId && /^[.\/!#]/.test(rawText);
    const entry = pendingIgurl.get(sessionStateKey(sock, jid));

    let choice = null;
    if (buttonId === 'igurl_type_video') choice = 'video';
    else if (buttonId === 'igurl_type_audio') choice = 'audio';
    else if (!buttonId) {
        const t = rawText.replace(/^[.\/!#]+/, '').trim().toLowerCase();
        if (t === 'video') choice = 'video';
        else if (t === 'audio') choice = 'audio';
    }

    if (!choice) {
        if (isCommandAttempt) return false;
        await reply(sock, jid, msg, box('INSTAGRAM DOWNLOAD', 'Please select Video or Audio.'));
        return true;
    }

    pendingIgurl.delete(sessionStateKey(sock, jid));
    try {
        await downloadAndSend(sock, jid, msg, choice, entry.url, entry.title);
    } catch (error) {
        await reply(sock, jid, msg, box('INSTAGRAM DOWNLOAD', friendlyDownloadError(error, 'Instagram post')));
    }
    return true;
}

async function handleIgurlCommand(sock, jid, msg, command, params, sender, senderIsOwner) {
    switch (command) {
        case 'ig':
        case 'instagram': {
            const inputUrl = extractUrl(params[0] || '') || (params[0] || '').trim();

            if (!inputUrl) {
                await reply(sock, jid, msg, box('INSTAGRAM DOWNLOAD', 'Send an Instagram post or reel link with the command.\nExample: .igurl https://www.instagram.com/reel/xxxxxxxx'));
                break;
            }

            if (!isInstagramLink(inputUrl)) {
                await reply(sock, jid, msg, box('INSTAGRAM DOWNLOAD', 'This does not look like a valid Instagram post or reel link.'));
                break;
            }

            await reply(sock, jid, msg, '𝐓𝐀𝐋𝐊𝐋𝐄𝐒𝐒 𝐒𝐎𝐂𝐈𝐀𝐋 𝐒𝐘𝐒𝐓𝐄𝐌𝐒 𝐅𝐄𝐓𝐂𝐇𝐈𝐍𝐆 MEDIA');

            try {
                const media = await resolveInstagramMedia(inputUrl);

                if (!media) {
                    throw new Error('Could not find downloadable media in this post');
                }

                if (media.type === 'carousel') {
                    for (let i = 0; i < media.items.length; i++) {
                        const item = media.items[i];
                        const mediaResponse = await httpGet(item.url);
                        if (mediaResponse.statusCode !== 200) continue;

                        if (item.type === 'video') {
                            await reply(sock, jid, msg, {
                                video: mediaResponse.body,
                                mimetype: 'video/mp4',
                                caption: i === 0 ? box('INSTAGRAM DOWNLOAD', 'Carousel post (' + media.items.length + ' items)') : ''
                            });
                        } else {
                            await reply(sock, jid, msg, {
                                image: mediaResponse.body,
                                caption: i === 0 ? box('INSTAGRAM DOWNLOAD', 'Carousel post (' + media.items.length + ' items)') : ''
                            });
                        }
                    }
                    break;
                }

                if (media.type === 'image') {
                    const mediaResponse = await httpGet(media.url);
                    if (mediaResponse.statusCode !== 200) {
                        throw new Error('Media download returned status ' + mediaResponse.statusCode);
                    }
                    await reply(sock, jid, msg, {
                        image: mediaResponse.body,
                        caption: box('INSTAGRAM DOWNLOAD', media.title || 'Here is your image.')
                    });
                    break;
                }

                await downloadAndSend(sock, jid, msg, 'video', media.url, media.title);
            } catch (error) {
                await reply(sock, jid, msg, box('INSTAGRAM DOWNLOAD', friendlyDownloadError(error, 'Instagram post')));
            }
            break;
        }
    }
}

module.exports = {
    handleIgurlCommand,
    IGURL_COMMANDS,
    isPendingIgurlRequest,
    handlePendingIgurlReply
};
