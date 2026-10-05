'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Store, StoreError } = require('./lib/store');

/* ---------- 시트 연결 선택 ---------- */
function createBackend() {
  const kind = (process.env.SHEETS_BACKEND || 'google').toLowerCase();
  if (kind === 'memory') {
    const { MemorySheets } = require('./lib/sheets-memory');
    let seed;
    if (process.env.MEMORY_SEED) seed = JSON.parse(require('fs').readFileSync(process.env.MEMORY_SEED, 'utf8'));
    return { backend: new MemorySheets({ seed, file: process.env.MEMORY_FILE }), kind };
  }
  const { GoogleSheets, loadCredentials } = require('./lib/sheets-google');
  const credentials = loadCredentials();
  return { backend: new GoogleSheets({ spreadsheetId: process.env.SPREADSHEET_ID, credentials }), kind };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createApp(opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  let store = opts.store || null;
  let configError = null;
  let backendKind = opts.backendKind || 'custom';
  if (!store) {
    try {
      const { backend, kind } = createBackend();
      backendKind = kind;
      store = new Store(backend);
    } catch (e) {
      configError = e.message;
      console.error('[config]', e.message);
    }
  }
  const APP_PASSCODE = opts.appPasscode !== undefined ? opts.appPasscode : (process.env.APP_PASSCODE || '');
  const ADMIN_PASSCODE = opts.adminPasscode !== undefined ? opts.adminPasscode : (process.env.ADMIN_PASSCODE || '');

  const requireStore = (req, res, next) => {
    if (!store) return res.status(503).json({ error: 'not_configured', message: `서버 설정이 필요합니다: ${configError}` });
    next();
  };
  const requireApp = (req, res, next) => {
    if (APP_PASSCODE && !safeEqual(req.get('x-app-passcode'), APP_PASSCODE)) return res.status(401).json({ error: 'passcode', message: '비밀번호가 필요합니다.' });
    next();
  };
  const requireAdmin = (req, res, next) => {
    if (!ADMIN_PASSCODE) return res.status(403).json({ error: 'admin_disabled', message: '관리자 비밀번호(ADMIN_PASSCODE)가 서버에 설정되지 않았습니다.' });
    if (!safeEqual(req.get('x-admin-passcode'), ADMIN_PASSCODE)) return res.status(401).json({ error: 'admin_passcode', message: '관리자 비밀번호가 올바르지 않습니다.' });
    next();
  };
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      if (e instanceof StoreError) {
        const status = { CONFLICT: 409, INVALID: 400, NOT_FOUND: 404, MIGRATION_PENDING: 409, ALREADY_MIGRATED: 409, READ_ONLY: 423, VERIFY_BEFORE_WRITE: 500, VERIFY_AFTER_WRITE: 500 }[e.code] || 500;
        return res.status(status).json({ error: e.code, message: e.message, conflicts: e.conflicts, diffs: e.diffs });
      }
      console.error('[api]', req.method, req.path, e);
      const msg = e && e.errors && e.errors[0] ? e.errors[0].message : (e && e.message) || String(e);
      res.status(502).json({ error: 'backend', message: `구글 시트 연결 오류: ${msg}` });
    }
  };

  /* ---------- API ---------- */
  app.get('/api/health', (req, res) => {
    res.json({ ok: !!store && !configError, backend: backendKind, configError, passcodeRequired: !!APP_PASSCODE });
  });

  app.get('/api/data', requireStore, requireApp, wrap(() => store.getData()));
  app.post('/api/save', requireStore, requireApp, wrap((req) => store.save(req.body)));

  app.get('/api/backups', requireStore, requireApp, wrap(async () => ({ backups: await store.listBackups() })));
  app.post('/api/backups', requireStore, requireApp, wrap((req) => store.createBackup(String((req.body && req.body.name) || '').slice(0, 200))));
  app.post('/api/backups/:id/restore', requireStore, requireApp, wrap((req) => store.restoreBackup(req.params.id)));
  app.delete('/api/backups/:id', requireStore, requireApp, wrap((req) => store.deleteBackup(req.params.id)));

  app.get('/api/admin/status', requireStore, requireAdmin, wrap(async () => {
    const info = await store.backend.describe();
    const check = await store.integrityCheck();
    return { sheet: info, backend: backendKind, ...check };
  }));
  app.post('/api/admin/migrate/preview', requireStore, requireAdmin, wrap((req) => store.migrationPreview(req.body && req.body.sourceJson)));
  app.post('/api/admin/migrate/apply', requireStore, requireAdmin, wrap((req) => {
    if (!req.body || req.body.confirm !== true) throw new StoreError('INVALID', '확인 값이 없습니다.');
    return store.migrationApply(req.body.sourceJson);
  }));
  app.post('/api/admin/unlock', requireStore, requireAdmin, wrap(async () => { store.unlockReadOnly(); return { ok: true }; }));

  /* ---------- 화면 ---------- */
  app.use(express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

  app.locals.store = store;
  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`홀덤 장부 서버 실행 중 → http://localhost:${port}`));
}

module.exports = { createApp };
