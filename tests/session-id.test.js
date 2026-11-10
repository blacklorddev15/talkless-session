// Run: node tests/session-id.test.js
'use strict';
const assert = require('assert');
const {
  decodeSessionString, phoneFromCreds, missingCredFields, stripWrappers,
} = require('../helper/sessionId');

const CREDS = {
  noiseKey: { private: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', public: 'BBBB=' },
  signedIdentityKey: { private: 'CCCC=', public: 'DDDD=' },
  signedPreKey: { keyPair: { private: 'EEEE=', public: 'FFFF=' }, signature: 'GGGG=', keyId: 1 },
  advSecretKey: 'HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
  me: { id: '254704955033:12@s.whatsapp.net', name: 'Talkless' },
  registered: true,
};

const json = JSON.stringify(CREDS);
const b64 = Buffer.from(json).toString('base64');
const urlSafe = b64.replace(/\+/g, '-').replace(/\//g, '_');
const wrapped = Buffer.from(JSON.stringify({ creds: CREDS })).toString('base64');
const doubleEncoded = JSON.stringify(JSON.stringify(CREDS));

const cases = [
  ['raw base64', b64, 'base64'],
  ['TALKLESS! prefix', 'TALKLESS!' + b64, 'base64'],
  ['TALKLESS-MD! prefix', 'TALKLESS-MD!' + b64, 'base64'],
  ['lowercase talkless!', 'talkless!' + b64, 'base64'],
  ['prefix + space', 'TALKLESS! ' + b64, 'base64'],
  ['json fence', '```json\n' + b64 + '\n```', 'base64'],
  ['bare fence', '```\n' + b64 + '\n```', 'base64'],
  ['url-safe base64', urlSafe, 'base64'],
  ['wrapped newlines', b64.replace(/(.{40})/g, '$1\n'), 'base64'],
  ['{creds:{…}} base64', wrapped, 'base64'],
  ['raw creds.json', json, 'json'],
  ['raw {creds:{…}} json', JSON.stringify({ creds: CREDS }), 'json'],
  ['double-encoded json string', doubleEncoded, 'json'],
];

let passed = 0;
for (const [label, input, expectedFormat] of cases) {
  const res = decodeSessionString(input);
  assert.strictEqual(res.ok, true, `${label}: expected ok, got ${JSON.stringify(res)}`);
  assert.strictEqual(res.format, expectedFormat, `${label}: format`);
  assert.strictEqual(res.creds.me.id, CREDS.me.id, `${label}: creds.me.id`);
  assert.strictEqual(phoneFromCreds(res.creds), '254704955033', `${label}: phone`);
  passed++;
}

// ── rejections ────────────────────────────────────────────────
const foreign = [
  ['Pixel! prefix', 'Pixel!' + b64, 'pixel'],
  ['Blacklord! prefix', 'Blacklord!' + b64, 'blacklord'],
  ['Varnox! prefix', 'varnox!' + b64, 'varnox'],
  ['Astro! prefix', 'Astro!' + b64, 'astro'],
];
for (const [label, input, brand] of foreign) {
  const res = decodeSessionString(input);
  assert.strictEqual(res.ok, false, `${label}: expected rejection`);
  assert.strictEqual(res.reason, 'foreign_prefix', `${label}: reason`);
  assert.strictEqual(res.brand.toLowerCase(), brand, `${label}: brand`);
  passed++;
}

// Any other "<word>!" is refused too — TALKLESS is the only accepted prefix.
for (const label of ['SomeBot!', 'WA-MD!', 'Xyz!']) {
  const res = decodeSessionString(label + b64);
  assert.strictEqual(res.ok, false, `${label}: expected rejection`);
  assert.strictEqual(res.reason, 'unknown_prefix', `${label}: reason`);
  passed++;
}

// Empty / junk
const bad = [
  ['empty', '   '],
  ['plain text', 'hello there'],
  ['truncated base64', 'eyJub2lzZUtleQ'],
  ['json but not creds', '{"foo":"bar"}'],
  ['array', Buffer.from('[1,2,3]').toString('base64')],
];
for (const [label, input] of bad) {
  const res = decodeSessionString(input);
  assert.strictEqual(res.ok, false, `${label}: expected rejection, got ${JSON.stringify(res)}`);
  passed++;
}

// ── phone edge cases ─────────────────────────────────────────
assert.strictEqual(phoneFromCreds({ me: { id: '254704955033@s.whatsapp.net' } }), '254704955033');
assert.strictEqual(phoneFromCreds({ me: { id: '254704955033:7@s.whatsapp.net' } }), '254704955033');
assert.strictEqual(phoneFromCreds({ me: { id: '123' } }), null);
assert.strictEqual(phoneFromCreds({}), null);
assert.strictEqual(phoneFromCreds(null), null);
passed += 5;

// ── soft key check ───────────────────────────────────────────
assert.deepStrictEqual(missingCredFields(CREDS), []);
assert.deepStrictEqual(
  missingCredFields({ me: { id: '254704955033@s.whatsapp.net' } }),
  ['noiseKey', 'signedIdentityKey', 'signedPreKey', 'advSecretKey', 'registered'],
);
passed += 2;

// ── wrapper stripping ────────────────────────────────────────
assert.strictEqual(stripWrappers('```json\nTALKLESS!' + b64 + '\n```'), b64);
// Foreign prefixes are deliberately NOT stripped — decodeSessionString rejects
// them before this point, and leaving them intact proves the gate ran.
assert.strictEqual(stripWrappers('Pixel!' + b64), 'Pixel!' + b64);
passed += 2;

console.log(`ok — ${passed} assertions passed`);
