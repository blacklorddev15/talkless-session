// ============================================================
//   helper/sessionId.js
//   Pixel-compatible session-ID parser.
//
//   Accepts everything the Pixel panel accepts, plus a few
//   formats pair sites emit in the wild:
//
//     • Base64 of creds.json (optionally wrapped as {creds:{…}})
//     • Base64 with a brand prefix  → Pixel!, Blacklord!, Varnox!,
//       Astro!, TALKLESS!, June-MD!, or any "<word>!" token
//     • Base64 wrapped in ``` fences (json / txt / no language)
//     • URL-safe Base64 (- and _)
//     • Base64 split across lines (Telegram wraps long strings)
//     • Raw creds.json JSON
//     • Double-encoded JSON (a JSON string containing JSON)
//
//   The only field treated as mandatory is creds.me.id — same
//   contract as the Pixel panel. Everything else is reported as
//   "missing" so the caller can warn instead of refusing.
// ============================================================
'use strict';

// Only TALKLESS prefixes are accepted. `TALKLESS-MD!` is kept as an alias
// because older builds emitted it; everything else is rejected by name.
const BRAND_PREFIX = /^TALKLESS(?:[-_ ]?MD)?\s*!\s*/i;
const FOREIGN_PREFIX = /^(pixel|blacklord|varnox|astro|junex?|amber)\s*[!-]/i;
const ANY_PREFIX = /^[A-Za-z0-9_.-]{2,24}\s*!/;
const FENCE_OPEN    = /^```[A-Za-z0-9_-]*[ \t]*\r?\n?/;
const FENCE_CLOSE   = /```[ \t]*$/;
const B64_CHARS     = /^[A-Za-z0-9+/]+={0,2}$/;

// Fields Baileys needs beyond me.id; missing ones usually mean a stale/broken export.
const CORE_CRED_FIELDS = ['noiseKey', 'signedIdentityKey', 'signedPreKey', 'advSecretKey', 'registered'];

/** Strip code fences and any "<brand>!" prefix, collapse all whitespace. */
function stripWrappers(input) {
  let text = String(input == null ? '' : input)
    .replace(/^\uFEFF/, '')
    .trim();

  // ```json\n…\n```  /  ```\n…\n```  (closing fence may be on the same line)
  if (text.startsWith('```')) {
    text = text.replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '').trim();
  }

  // Repeated in case of "```json" + "TALKLESS!…"
  let guard = 0;
  while (guard++ < 3) {
    const next = text.replace(BRAND_PREFIX, '').replace(FENCE_OPEN, '').trim();
    if (next === text) break;
    text = next;
  }

  return text.replace(/\s+/g, '');
}

/** Buffer.from(x,'base64') never throws on junk — check the shape first. */
function fromBase64(text) {
  const normalised = text.replace(/-/g, '+').replace(/_/g, '/');
  if (!B64_CHARS.test(normalised)) return null;
  if (normalised.length < 16) return null;
  const decoded = Buffer.from(normalised, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!decoded.startsWith('{') && !decoded.startsWith('"')) return null;
  return decoded;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Unwrap {creds:{…}}, double-encoded strings, and {session:{…}} shapes. */
function unwrap(value, depth = 0) {
  if (depth > 3 || value == null) return value;
  if (typeof value === 'string') {
    const parsed = parseJson(value.trim());
    return parsed === undefined ? value : unwrap(parsed, depth + 1);
  }
  if (typeof value !== 'object') return value;
  if (value.creds && typeof value.creds === 'object') return unwrap(value.creds, depth + 1);
  if (value.session && typeof value.session === 'object') return unwrap(value.session, depth + 1);
  if (value.data && typeof value.data === 'object' && (value.data.me || value.data.noiseKey)) {
    return unwrap(value.data, depth + 1);
  }
  return value;
}

/**
 * @param {string} input raw Telegram message text
 * @returns {{ok:true, creds:object, format:'json'|'base64'} | {ok:false, reason:string}}
 */
function decodeSessionString(input) {
  // Fences first, so "```json\nPixel!…```" is still recognised as foreign.
  const defenced = String(input == null ? '' : input)
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(FENCE_OPEN, '')
    .replace(FENCE_CLOSE, '')
    .trim();

  const foreign = defenced.match(FOREIGN_PREFIX);
  if (foreign) return { ok: false, reason: 'foreign_prefix', brand: foreign[1] };

  // Anything that looks like "<word>!" but is not TALKLESS is refused, so a
  // session can never arrive wearing another product's name.
  if (ANY_PREFIX.test(defenced) && !BRAND_PREFIX.test(defenced)) {
    return { ok: false, reason: 'unknown_prefix', token: defenced.match(ANY_PREFIX)[0] };
  }

  const cleaned = stripWrappers(input);
  if (!cleaned) return { ok: false, reason: 'empty' };

  let parsed;
  let format;

  if (cleaned.startsWith('{') || cleaned.startsWith('"')) {
    parsed = parseJson(cleaned);
    format = 'json';
    if (parsed === undefined) return { ok: false, reason: 'not_json' };
  } else {
    const decoded = fromBase64(cleaned);
    if (!decoded) return { ok: false, reason: 'not_base64' };
    parsed = parseJson(decoded.replace(/\s+/g, ''));
    format = 'base64';
    if (parsed === undefined) return { ok: false, reason: 'not_json' };
  }

  const creds = unwrap(parsed);
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) {
    return { ok: false, reason: 'no_creds' };
  }
  const hasMe = creds.me && typeof creds.me === 'object';
  const hasCoreField = CORE_CRED_FIELDS.some((field) => creds[field] !== undefined);
  if (!hasMe && !hasCoreField) return { ok: false, reason: 'no_creds' };

  return { ok: true, creds, format };
}

/** creds.me.id → "254704955033" (JID, device suffix and @server stripped). */
function phoneFromCreds(creds) {
  const raw = creds && creds.me && creds.me.id;
  if (!raw) return null;
  const digits = String(raw).split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

function missingCredFields(creds) {
  if (!creds || typeof creds !== 'object') return CORE_CRED_FIELDS.slice();
  return CORE_CRED_FIELDS.filter((field) => creds[field] === undefined || creds[field] === null);
}

module.exports = {
  decodeSessionString,
  phoneFromCreds,
  missingCredFields,
  stripWrappers,
  CORE_CRED_FIELDS,
};
