import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3002', 10);
const CONFIG_PATH = process.env.FALLBACK_CONFIG_PATH || path.join(__dirname, 'fallback-config.json');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'freellmapi.db');

// Ensure default fallback-config.json exists
function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultCfg = {
      waitAndRetryRpm: true,
      maxWaitSeconds: 15,
      jitterMs: 250,
      strictSingleProvider: true,
      fallbackCompression: true,
    };
    try {
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultCfg, null, 2), 'utf-8');
    } catch {}
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
    strictSingleProvider: true,
    fallbackCompression: true,
  };
}

// Support native SQLite (node:sqlite) or better-sqlite3 gracefully
let Database = null;
try {
  const sqlite = await import('node:sqlite');
  Database = sqlite.DatabaseSync;
} catch {
  try {
    const bSqlite = await import('better-sqlite3');
    Database = bSqlite.default;
  } catch {
    // SQLite driver will be detected if present in runtime
  }
}

function queryDatabase() {
  const candidates = [
    DB_PATH,
    '/data/freellmapi.db',
    '/app/server/data/freellmapi.db',
    path.join(__dirname, '..', 'server', 'data', 'freellmapi.db'),
    path.join(__dirname, 'freellmapi.db'),
  ];
  let activePath = candidates.find(p => fs.existsSync(p));

  if (!activePath || !Database) {
    return {
      connected: false,
      message: activePath ? 'Driver SQLite in attesa' : 'Database SQLite non ancora rilevato su disco',
      summary: { totalKeys: 0, healthyKeys: 0, activeCooldowns: 0, totalLoggedAttempts: 0 },
      cooldowns: [],
      keys: [],
      recentAttempts: [],
    };
  }

  try {
    const db = new Database(activePath, { readOnly: true, readonly: true });
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 1. Web Dashboard
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
  }

  // 2. Healthcheck
  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // 3. GET /api/config
  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getConfig()));
    return;
  }

  // 4. POST /api/config
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
          strictSingleProvider: Boolean(parsed.strictSingleProvider ?? current.strictSingleProvider),
          fallbackCompression: Boolean(parsed.fallbackCompression ?? current.fallbackCompression),
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), 'utf-8');
        console.log('[Console] Regole salvate con successo:', updated);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, config: updated }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Errore durante il salvataggio', details: err.message }));
      }
    });
    return;
  }

  // 5. GET /api/database
  if (req.method === 'GET' && url.pathname === '/api/database') {
    const data = queryDatabase();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // 6. Servizio file patch per Docker Init / Download
  if (req.method === 'GET' && url.pathname.startsWith('/patch/')) {
    const filename = path.basename(url.pathname);
    const patchPath = path.join(__dirname, 'patch', filename);
    if (fs.existsSync(patchPath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      fs.createReadStream(patchPath).pipe(res);
      return;
    }
  }

  // 404 Fallback
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[FLLMAPI Console] Server avviato con successo su http://0.0.0.0:${PORT}`);
});
