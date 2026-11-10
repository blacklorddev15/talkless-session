// ============================================================
//   helper/talkless-neon.js  –  Neon pairing channel for TALKLESS ULTRA
//
//   The website (Vercel) writes pairing requests to Neon
//   (talkless_pairing_requests). This bot polls them every 3s,
//   generates the WhatsApp pairing code, and writes it back.
// ============================================================
'use strict';

// Containers/VPS often have no IPv6 route - force IPv4-first DNS so Postgres
// connections don't hang on IPv6 and die with ETIMEDOUT.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (_) { /* older node */ }

const { Pool } = require('pg');

// Build the pool without relying on the `sslmode` query parameter, which older
// pg versions ignore (that makes Neon reject non-TLS connections -> poll errors).
// We always connect over TLS and don't hard-fail on certificate chain checks.
const NEON_URL = String(process.env.NEON_DATABASE_URL || require('../settings').NEON_DATABASE_URL || '').split('?')[0];

const pool = new Pool({
  connectionString: NEON_URL || undefined,
  ...(NEON_URL ? { ssl: { rejectUnauthorized: false } } : {}),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5,
});

pool.on('error', (err) => {
  console.error('[TALKLESS-NEON] idle client error:', err && (err.stack || err.message || err));
});

let _announcedConnected = false;

// One-time console announcement once the bot can actually reach the
// pairing website's Neon database.
async function announceWebsiteConnected() {
  if (_announcedConnected) return;
  try {
    await pool.query('SELECT 1');
    console.log('[TALKLESS-NEON] WEBSITE CONNECTED - Neon pairing channel is online. Waiting for pairing requests...');
    _announcedConnected = true;
  } catch (e) {
    console.error('[TALKLESS-NEON] WEBSITE NOT CONNECTED YET - ' + (e && (e.message || e)));
  }
}

async function claimPairingRequest() {
  const { rows } = await pool.query(
    `UPDATE talkless_pairing_requests SET status = 'processing', updated_at = now()
     WHERE id = (SELECT id FROM talkless_pairing_requests
                 WHERE status = 'pending' AND expires_at > now()
                 ORDER BY id LIMIT 1)
     RETURNING *`
  );
  return rows[0] || null;
}

async function setPairingCode(id, code) {
  await pool.query(
    `UPDATE talkless_pairing_requests SET status = 'code_generated', pairing_code = $1, updated_at = now() WHERE id = $2`,
    [code, id]
  );
}

async function markPairingFailed(id, error) {
  await pool.query(
    `UPDATE talkless_pairing_requests SET status = 'failed', error = $1, updated_at = now() WHERE id = $2`,
    [String(error || 'unknown reason').slice(0, 300), id]
  );
}

async function markPairingConnected(id, phone) {
  await pool.query(
    `UPDATE talkless_pairing_requests SET status = 'connected', updated_at = now() WHERE id = $1`,
    [id]
  );
}

async function expireStaleRequests() {
  await pool.query(
    `UPDATE talkless_pairing_requests SET status = 'expired'
     WHERE status IN ('pending', 'processing') AND expires_at < now()`
  );
}

// Mirror active sessions to Neon so the website stats are real
async function upsertSession(sessionId, phone, status) {
  try {
    await pool.query(
      `INSERT INTO talkless_sessions (id, phone, status, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, status = EXCLUDED.status, updated_at = now()`,
      [sessionId, phone || null, status]
    );
  } catch { /* stats only – never crash the bot */ }
}

// starter: (sessionId, phone, pairingCodeCallback) => Promise<sock>
function startTalklessPairingLoop(starter) {
  const neonUrl = process.env.NEON_DATABASE_URL || require('../settings').NEON_DATABASE_URL;
  if (!neonUrl) {
    console.warn('[TALKLESS-NEON] NEON_DATABASE_URL not set - website pairing loop disabled. Set it in .env to enable.');
    return;
  }
  setInterval(async () => {
    try {
      const row = await claimPairingRequest();
      if (!row) return;
      _announcedConnected = true; // a successful claim proves the website channel is up
      console.log(`[TALKLESS-NEON] WEBSITE CONNECTED - pairing request #${row.id} for +${row.phone} claimed from the website.`);

      const sessionId = `web_${row.phone}`;

      if (global._activeSockets && global._activeSockets.has(sessionId)) {
        await markPairingFailed(row.id, 'This number is already connected.');
        return;
      }
      const { sessionExists, deleteSession } = require('./function');
      if (sessionExists(sessionId)) {
        // website sessions (web_*) are self-healing: a stale folder from a
        // previous failed attempt must not block a new pairing request
        try {
          console.warn('[TALKLESS-NEON] stale web_ session found - deleting:', sessionId);
          deleteSession(sessionId);
        } catch (e) {
          console.warn('[TALKLESS-NEON] could not delete stale session:', e.message);
        }
      }

      // Watchdog: if WhatsApp has not produced a code within 90s, fail the row
      // instead of leaving it stuck in 'processing' until it expires.
      const watchdog = setTimeout(async () => {
        try {
          const q = await pool.query(
            'SELECT status FROM talkless_pairing_requests WHERE id = $1',
            [row.id]
          );
          if (q.rows[0] && q.rows[0].status === 'processing') {
            await markPairingFailed(row.id, 'Timed out waiting for WhatsApp pairing code.');
          }
        } catch (_) { /* ignore */ }
      }, 90000);

      const sock = await starter(sessionId, row.phone, async (code) => {
        clearTimeout(watchdog);
        await setPairingCode(row.id, code);
      });
      if (sock) {
        sock.__pairingRequestId = row.id;
        sock.__pairingError = (errMsg) => markPairingFailed(row.id, errMsg);
      }
    } catch (e) {
      console.error('[TALKLESS-NEON] poll error:', e && (e.stack || e.message || e));
    }
  }, 3000);

  setInterval(() => {
    expireStaleRequests().catch(() => {});
  }, 60000);

  // Retry the announcement quietly until the website channel is reachable.
  setInterval(() => {
    if (!_announcedConnected) announceWebsiteConnected();
  }, 60000);

  console.log('[TALKLESS-NEON] Pairing loop started (3s interval)');
  try {
    const host = (new URL(neonUrl)).host;
    console.log('[TALKLESS-NEON] Neon host:', host);
  } catch (_) { /* ignore */ }
  announceWebsiteConnected();
}

module.exports = {
  startTalklessPairingLoop,
  claimPairingRequest,
  setPairingCode,
  markPairingFailed,
  markPairingConnected,
  expireStaleRequests,
  upsertSession,
};
