import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3002', 10);
const CONFIG_PATH = process.env.FALLBACK_CONFIG_PATH || path.join(__dirname, 'fallback-config.json');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'freellmapi.db');

// Session secret derived from env or generated securely
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const MASTER_PASSWORD = process.env.CONSOLE_PASSWORD || null;

// Ensure default fallback-config.json and patch/fallback-loop.js exist in config dir
function ensureConfig() {
  const dir = path.dirname(CONFIG_PATH);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}

  const defaultCfg = {
    waitAndRetryRpm: true,
    maxWaitSeconds: 15,
    jitterMs: 250,
    rotateOnlyOnDailyQuota: true,
    preFlightTpmCheck: true,
    strictSingleProvider: true,
  };

  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultCfg, null, 2), 'utf-8');
    }
  } catch {}

  // Also ensure /config/fallback-loop.js is populated so freellmapi can mount or copy it
  try {
    const localPatch = path.join(__dirname, 'patch', 'fallback-loop.js');
    const targetPatch = path.join(dir, 'fallback-loop.js');
    if (fs.existsSync(localPatch)) {
      fs.copyFileSync(localPatch, targetPatch);
      console.log('[Console Patch] fallback-loop.js sincronizzato in', targetPatch);
    }
  } catch (err) {
    console.warn('[Console Patch] Impossibile copiare fallback-loop.js:', err.message);
  }
}
ensureConfig();

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('[Console] Errore lettura config:', err.message);
  }
  return {
    waitAndRetryRpm: true,
    maxWaitSeconds: 15,
    jitterMs: 250,
    rotateOnlyOnDailyQuota: true,
    preFlightTpmCheck: true,
    strictSingleProvider: true,
  };
}

// Support native SQLite (node:sqlite) or better-sqlite3 gracefully
let Database = null;
try {
  const sqlite = await import('node:sqlite');
  Database = sqlite.DatabaseSync;
  console.log('[Console DB] Modulo nativo node:sqlite caricato con successo');
} catch (err) {
  console.warn('[Console DB] node:sqlite non caricabile:', err.message);
  try {
    const bSqlite = await import('better-sqlite3');
    Database = bSqlite.default;
  } catch {}
}

function findActiveDbPath() {
  // 1. If DB_PATH is explicitly set and exists as a file, return it
  if (DB_PATH && fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).isFile()) {
    return DB_PATH;
  }

  // 2. Direct candidate file paths (checking both freeapi.db and freellmapi.db)
  const candidateFiles = [
    DB_PATH,
    '/app/server/data/freeapi.db',
    '/app/server/data/freellmapi.db',
    '/data/freeapi.db',
    '/data/freellmapi.db',
    path.join(__dirname, '..', 'server', 'data', 'freeapi.db'),
    path.join(__dirname, '..', 'server', 'data', 'freellmapi.db'),
    path.join(__dirname, 'freeapi.db'),
    path.join(__dirname, 'freellmapi.db'),
  ];
  const foundFile = candidateFiles.find(p => p && fs.existsSync(p) && fs.statSync(p).isFile());
  if (foundFile) return foundFile;

  // 3. Scan candidate directories for ANY .db file (e.g. if DB_PATH was a directory or named differently)
  const candidateDirs = [
    DB_PATH ? (fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).isDirectory() ? DB_PATH : path.dirname(DB_PATH)) : null,
    '/app/server/data',
    '/data',
  ].filter(Boolean);

  for (const dir of candidateDirs) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const files = fs.readdirSync(dir);
        console.log(`[Console DB] Ispezione cartella ${dir}:`, files);
        const match = files.find(f => f.endsWith('.db') && !f.includes('journal') && !f.includes('wal'));
        if (match) {
          const matchedPath = path.join(dir, match);
          console.log(`[Console DB] Trovato file database: ${matchedPath}`);
          return matchedPath;
        }
      }
    } catch (e) {
      console.warn(`[Console DB] Impossibile leggere directory ${dir}:`, e.message);
    }
  }

  return null;
}

function getDbInstance() {
  if (!Database) {
    console.warn('[Console DB] Driver SQLite non disponibile');
    return null;
  }
  const activePath = findActiveDbPath();
  if (!activePath) {
    console.warn('[Console DB] Nessun database trovato nei percorsi candidati (cercato freeapi.db / freellmapi.db)');
    return null;
  }
  try {
    return new Database(activePath, { readOnly: true, readonly: true });
  } catch (err) {
    console.error('[Console DB] Errore apertura database SQLite (' + activePath + '):', err.message);
    return null;
  }
}

// ── Auth & Password Verification (Same scrypt algorithm as FreeLLMAPI) ───
function verifyPassword(password, stored) {
  if (!password || !stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createSessionToken(email) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Date.now() + 7 * 24 * 3600 * 1000 // 7 days valid
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function getAuthUser(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return verifySessionToken(authHeader.slice(7).trim());
  }
  const cookieHeader = req.headers['cookie'];
  if (cookieHeader) {
    const match = cookieHeader.match(/fllm_console_session=([^;]+)/);
    if (match) return verifySessionToken(decodeURIComponent(match[1]));
  }
  return null;
}

function queryDatabase() {
  const db = getDbInstance();
  if (!db) {
    return {
      connected: false,
      message: 'Database SQLite non ancora rilevato su disco',
      summary: { totalKeys: 0, healthyKeys: 0, activeCooldowns: 0, totalLoggedAttempts: 0 },
      cooldowns: [],
      keys: [],
      recentAttempts: [],
    };
  }

  try {
    let cooldowns = [];
    let keys = [];
    let recentAttempts = [];

    try {
      const q = db.prepare('SELECT platform, model_id, key_id, expires_at_ms, created_at FROM rate_limit_cooldowns ORDER BY expires_at_ms DESC LIMIT 50');
      cooldowns = typeof q.all === 'function' ? q.all() : [];
    } catch {}

    try {
      const q = db.prepare('SELECT id, platform, label, status, enabled, last_checked_at FROM api_keys ORDER BY id ASC');
      keys = typeof q.all === 'function' ? q.all() : [];
    } catch {}

    try {
      const q = db.prepare(`
        SELECT a.id, a.request_id, a.ordinal, a.platform, a.model_id, a.outcome, a.duration_ms, 
               r.created_at, r.status as req_status
        FROM request_attempts a
        LEFT JOIN requests r ON a.request_id = r.id
        ORDER BY a.id DESC LIMIT 40
      `);
      recentAttempts = typeof q.all === 'function' ? q.all() : [];
    } catch {}

    if (typeof db.close === 'function') db.close();

    const nowMs = Date.now();
    const activeCooldowns = cooldowns.filter(c => c.expires_at_ms > nowMs).length;
    const healthyKeys = keys.filter(k => k.enabled && k.status !== 'invalid').length;

    return {
      connected: true,
      summary: {
        totalKeys: keys.length,
        healthyKeys,
        activeCooldowns,
        totalLoggedAttempts: recentAttempts.length,
      },
      cooldowns: cooldowns.map(c => ({
        ...c,
        isExpired: c.expires_at_ms <= nowMs,
        remainingSec: Math.max(0, Math.ceil((c.expires_at_ms - nowMs) / 1000)),
      })),
      keys,
      recentAttempts,
    };
  } catch (err) {
    if (db && typeof db.close === 'function') db.close();
    return {
      connected: false,
      error: err.message,
      summary: { totalKeys: 0, healthyKeys: 0, activeCooldowns: 0, totalLoggedAttempts: 0 },
      cooldowns: [],
      keys: [],
      recentAttempts: [],
    };
  }
}

// Zero-dependency native HTTP server
const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Helper per rispondere JSON
  const sendJson = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // 1. Static Web Dashboard
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
  }

  // 2. Healthcheck (pubblico)
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(200, { status: 'ok', uptime: process.uptime() });
    return;
  }

  // 3. Verifica stato Auth corrente (GET /api/auth/me)
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = getAuthUser(req);
    if (user) {
      sendJson(200, { authenticated: true, email: user.email });
    } else {
      sendJson(200, { authenticated: false });
    }
    return;
  }

  // 4. Login (POST /api/auth/login)
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body || '{}');

        // Opzione A: Master Password via env
        if (MASTER_PASSWORD && password === MASTER_PASSWORD) {
          const token = createSessionToken(email || 'admin');
          console.log('[Console Auth] Accesso riuscito via CONSOLE_PASSWORD');
          sendJson(200, { success: true, token, email: email || 'admin' });
          return;
        }

        // Opzione B: Verifica credenziali contro la tabella users di FreeLLMAPI
        const db = getDbInstance();
        if (!db) {
          sendJson(503, { error: 'Database FreeLLMAPI non ancora collegato. Riprova tra poco.' });
          return;
        }

        let userRow = null;
        try {
          if (email && email.trim()) {
            const q = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?');
            userRow = typeof q.get === 'function' ? q.get(email.trim().toLowerCase()) : null;
          } else {
            // Se l'utente inserisce solo la password, controlla il primo account unico
            const q = db.prepare('SELECT id, email, password_hash FROM users LIMIT 1');
            userRow = typeof q.get === 'function' ? q.get() : null;
          }
        } catch (e) {
          console.warn('[Console Auth] Query users table failed:', e.message);
        }

        if (typeof db.close === 'function') db.close();

        if (userRow && verifyPassword(password, userRow.password_hash)) {
          const token = createSessionToken(userRow.email);
          console.log(`[Console Auth] Login riuscito per ${userRow.email} usando credenziali FreeLLMAPI`);
          sendJson(200, { success: true, token, email: userRow.email });
          return;
        }

        console.warn(`[Console Auth] Tentativo di login fallito per email: ${email || 'unknown'}`);
        sendJson(401, { error: 'Email o password non validi' });
      } catch (err) {
        sendJson(500, { error: 'Errore interno', details: err.message });
      }
    });
    return;
  }

  // ── ROTTE PROTETTE DA AUTENTICAZIONE ─────────────────────────────────────
  const authUser = getAuthUser(req);
  if (!authUser) {
    sendJson(401, { error: 'Accesso negato. Effettua prima il login.', authenticated: false });
    return;
  }

  // 5. GET /api/config (protetto)
  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(200, getConfig());
    return;
  }

  // 6. POST /api/config (protetto)
  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const current = getConfig();
        const updated = {
          waitAndRetryRpm: Boolean(parsed.waitAndRetryRpm ?? current.waitAndRetryRpm),
          maxWaitSeconds: Math.min(Math.max(Number(parsed.maxWaitSeconds) || 15, 1), 60),
          jitterMs: Math.min(Math.max(Number(parsed.jitterMs) || 250, 0), 2000),
          rotateOnlyOnDailyQuota: Boolean(parsed.rotateOnlyOnDailyQuota ?? current.rotateOnlyOnDailyQuota),
          preFlightTpmCheck: Boolean(parsed.preFlightTpmCheck ?? current.preFlightTpmCheck),
          strictSingleProvider: Boolean(parsed.strictSingleProvider ?? current.strictSingleProvider),
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
        console.log(`[Console] Regole aggiornate da ${authUser.email}:`, updated);
        sendJson(200, { success: true, config: updated });
      } catch (err) {
        sendJson(500, { error: 'Errore durante il salvataggio', details: err.message });
      }
    });
    return;
  }

  // 7. GET /api/database (protetto)
  if (req.method === 'GET' && url.pathname === '/api/database') {
    sendJson(200, queryDatabase());
    return;
  }

  // 404 Fallback
  sendJson(404, { error: 'Endpoint non trovato' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[FLLMAPI Console] Server avviato con successo su http://0.0.0.0:${PORT}`);
  console.log(`[FLLMAPI Console] Protezione attiva: autenticazione sincronizzata con account FreeLLMAPI`);
});
