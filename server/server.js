'use strict';

/**
 * eibapks upload server — zero external dependencies (Node http only).
 *
 * Accepts a raw-body APK upload and atomically replaces the currently
 * served file for a given app, keeping a timestamped backup of the
 * previous version so a bad upload can be rolled back.
 *
 * Endpoints:
 *   GET  /api/health              -> { ok: true }
 *   GET  /api/list                -> current files (auth required)
 *   POST /api/upload/:app         -> replace app's apk (auth required, raw body)
 *
 * Auth: header  Authorization: Bearer <UPLOAD_SECRET>
 *
 * nginx serves the static site and the /apks/ directory directly; this
 * process only handles /api/*. See deploy/nginx-eibapks.conf.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- minimal .env loader (no dependency) ----------------------------------
(function loadEnv() {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// ---- config (env-driven) --------------------------------------------------
const PORT = parseInt(process.env.PORT || '8090', 10);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.UPLOAD_SECRET || '';
const APK_DIR = process.env.APK_DIR || path.resolve(__dirname, '..', 'apks');
const BACKUP_DIR = path.join(APK_DIR, 'backups');
const MAX_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(300 * 1024 * 1024), 10); // 300 MB
const KEEP_BACKUPS = parseInt(process.env.KEEP_BACKUPS || '5', 10);

// Whitelist: app slug -> served filename. Only these can be uploaded.
const APPS = {
  cgas: 'cgas.apk',
  lock: 'lock.apk',
  'lock-legacy': 'lock-legacy.apk',
  vanguard: 'vanguard.apk',
};

if (!SECRET) {
  console.error('FATAL: UPLOAD_SECRET is not set. Refusing to start.');
  process.exit(1);
}
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---- helpers --------------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Constant-time compare that never short-circuits on length.
function checkAuth(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const provided = m ? m[1] : '';
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

function fileInfo(fp) {
  try {
    const st = fs.statSync(fp);
    return { exists: true, size: st.size, modified: st.mtime.toISOString() };
  } catch {
    return { exists: false, size: 0, modified: null };
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pruneBackups(baseName) {
  try {
    const prefix = baseName + '.';
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((x, y) => y.t - x.t);
    for (const extra of files.slice(KEEP_BACKUPS)) {
      fs.unlinkSync(path.join(BACKUP_DIR, extra.f));
    }
  } catch (e) {
    console.warn('backup prune warning:', e.message);
  }
}

// ---- upload handler -------------------------------------------------------
function handleUpload(req, res, app) {
  const target = APPS[app];
  if (!target) return json(res, 404, { ok: false, error: 'unknown app' });

  const finalPath = path.join(APK_DIR, target);
  const tmpPath = path.join(APK_DIR, `.upload-${app}-${process.pid}-${Date.now()}.part`);

  let received = 0;
  let aborted = false;
  let sawZipMagic = null; // true/false once first bytes seen

  const out = fs.createWriteStream(tmpPath);

  function fail(code, error) {
    if (aborted) return;
    aborted = true;
    out.destroy();
    fs.promises.unlink(tmpPath).catch(() => {});
    json(res, code, { ok: false, error });
    req.destroy();
  }

  req.on('data', (chunk) => {
    if (aborted) return;

    // Verify APK/ZIP magic on the very first bytes: 50 4B 03 04.
    if (sawZipMagic === null && chunk.length >= 4) {
      sawZipMagic =
        chunk[0] === 0x50 && chunk[1] === 0x4b && chunk[2] === 0x03 && chunk[3] === 0x04;
      if (!sawZipMagic) return fail(415, 'not an APK (bad ZIP signature)');
    }

    received += chunk.length;
    if (received > MAX_BYTES) return fail(413, 'file too large');

    if (!out.write(chunk)) {
      req.pause();
      out.once('drain', () => req.resume());
    }
  });

  req.on('aborted', () => fail(400, 'client aborted'));

  req.on('end', () => {
    if (aborted) return;
    if (received === 0) return fail(400, 'empty body');
    if (sawZipMagic === false) return fail(415, 'not an APK');

    out.end(() => {
      try {
        // Back up the current file (if any) before replacing.
        if (fs.existsSync(finalPath)) {
          const bkp = path.join(BACKUP_DIR, `${target}.${timestamp()}`);
          fs.renameSync(finalPath, bkp);
          pruneBackups(target);
        }
        fs.renameSync(tmpPath, finalPath); // atomic within same filesystem
      } catch (e) {
        fs.promises.unlink(tmpPath).catch(() => {});
        return json(res, 500, { ok: false, error: 'replace failed: ' + e.message });
      }
      const info = fileInfo(finalPath);
      console.log(`[upload] ${app} <- ${received} bytes  (${target})`);
      json(res, 200, { ok: true, app, file: target, size: info.size, modified: info.modified });
    });
  });

  out.on('error', (e) => fail(500, 'write error: ' + e.message));
}

// ---- router ---------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['api','upload','cgas']

  // Public health check.
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'eibapks-upload' });
  }

  // Everything below requires auth.
  if (!checkAuth(req)) {
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }

  if (req.method === 'GET' && url.pathname === '/api/list') {
    const files = {};
    for (const [slug, name] of Object.entries(APPS)) {
      files[slug] = { file: name, ...fileInfo(path.join(APK_DIR, name)) };
    }
    return json(res, 200, { ok: true, apps: files });
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'upload' && parts[2]) {
    return handleUpload(req, res, parts[2]);
  }

  return json(res, 404, { ok: false, error: 'not found' });
});

server.requestTimeout = 0; // large uploads: don't cut off mid-stream
server.headersTimeout = 60 * 1000;

server.listen(PORT, HOST, () => {
  console.log(`eibapks upload server listening on http://${HOST}:${PORT}`);
  console.log(`serving apk dir: ${APK_DIR}`);
  console.log(`known apps: ${Object.keys(APPS).join(', ')}`);
});
