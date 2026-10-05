'use strict';
/*
 * 저장소: 구글 시트를 DB로 쓰는 모든 읽기/쓰기를 담당합니다.
 *
 * 데이터 보호 장치
 *  1) 한 번에 하나의 저장만 처리(잠금). 저장 직전에 항상 시트를 새로 읽습니다.
 *  2) 날짜별 버전 확인: 다른 기기가 먼저 고친 날짜를 덮어쓰려 하면 거절(conflict)합니다.
 *  3) 클라이언트가 "바꾼 날짜"만 반영합니다. 날짜 삭제는 명시적인 삭제 요청으로만 일어나며,
 *     화면에 일부 날짜만 있는 기기가 저장해도 나머지 날짜가 사라지지 않습니다.
 *  4) 쓰기 전: 메모리에서 쓰기→읽기를 흉내 내 원본과 같은지 확인(다르면 쓰지 않음).
 *  5) 쓰기 후: 시트를 다시 읽어 원본과 같은지 확인(다르면 즉시 읽기 전용으로 전환하고 알림).
 *  6) 하루 첫 저장 전, 날짜 삭제 전, 복원 전에는 자동 백업을 남깁니다.
 *  7) 예전 탭(latest/history)은 읽기만 합니다.
 */
const schema = require('./schema');
const legacy = require('./legacy');
const { newBackupId, DAY_ID_RE } = require('./ids');
const calc = require('../public/js/calc.js');

const { DATA_TABS, BACKUP_TAB, BACKUP_HEADERS } = schema;
const LEGACY_TAB = 'latest';
const CHUNK = 40000; // 구글 시트 한 칸 최대 50,000자 → 여유 있게 나눠 저장

class StoreError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); }
}

function sizeOf(tabs) {
  const sizes = {};
  for (const [t, rows] of Object.entries(tabs)) {
    if (!rows) { sizes[t] = { rows: 0, cols: 0 }; continue; }
    sizes[t] = { rows: rows.length, cols: rows.reduce((m, r) => Math.max(m, (r || []).length), 0) };
  }
  return sizes;
}
function padTabs(tabsRows, prevSizes) {
  const out = {};
  for (const [t, rows] of Object.entries(tabsRows)) {
    const prev = prevSizes[t] || { rows: 0, cols: 0 };
    const width = Math.max(prev.cols, ...rows.map((r) => r.length), 1);
    const height = Math.max(prev.rows, rows.length);
    const padded = [];
    for (let r = 0; r < height; r++) {
      const row = (rows[r] || []).map((c) => (c === undefined || c === null ? '' : c));
      while (row.length < width) row.push('');
      padded.push(row);
    }
    out[t] = padded;
  }
  return out;
}
function kstDate(d) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }

function emptyDataset() {
  return { days: [], roundCount: 3, roundLabels: ['1부', '2부', '3부'], currentDayId: '', extraMeta: {} };
}

/* ---------- 입력 검증 ---------- */
function validateState(state, where) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new StoreError('INVALID', `${where}: state 형식 오류`);
  const keys = Object.keys(state);
  if (keys.length > 5000) throw new StoreError('INVALID', `${where}: 항목이 너무 많습니다.`);
  for (const k of keys) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(k)) throw new StoreError('INVALID', `${where}: 잘못된 항목 이름 ${k}`);
    if (typeof state[k] !== 'string') throw new StoreError('INVALID', `${where}: ${k} 값은 문자열이어야 합니다.`);
    if (state[k].length > 2000) throw new StoreError('INVALID', `${where}: ${k} 값이 너무 깁니다.`);
  }
}
function validateSavePayload(p) {
  if (!p || typeof p !== 'object') throw new StoreError('INVALID', '요청 형식 오류');
  const changes = Array.isArray(p.changes) ? p.changes : [];
  const deletes = Array.isArray(p.deletes) ? p.deletes : [];
  if (changes.length > 1000 || deletes.length > 1000) throw new StoreError('INVALID', '한 번에 너무 많은 변경');
  const seen = new Set();
  for (const c of changes) {
    if (!c || typeof c.id !== 'string' || !DAY_ID_RE.test(c.id)) throw new StoreError('INVALID', '날짜 ID 형식 오류');
    if (seen.has(c.id)) throw new StoreError('INVALID', '같은 날짜가 두 번 포함됨');
    seen.add(c.id);
    if (!Number.isInteger(c.baseVersion) || c.baseVersion < 0) throw new StoreError('INVALID', '버전 정보 오류');
    if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 100) throw new StoreError('INVALID', '날짜명 오류');
    validateState(c.state, c.label);
  }
  for (const d of deletes) {
    if (!d || typeof d.id !== 'string' || !DAY_ID_RE.test(d.id) || !Number.isInteger(d.baseVersion)) throw new StoreError('INVALID', '삭제 요청 형식 오류');
    if (seen.has(d.id)) throw new StoreError('INVALID', '수정과 삭제가 같은 날짜에 동시에 요청됨');
  }
  if (p.order !== undefined && p.order !== null && (!Array.isArray(p.order) || p.order.some((x) => typeof x !== 'string'))) throw new StoreError('INVALID', '순서 정보 오류');
  if (p.meta) {
    const { roundCount, roundLabels } = p.meta;
    if (!Number.isInteger(roundCount) || roundCount < 1 || roundCount > 20) throw new StoreError('INVALID', '부 개수 오류');
    if (!Array.isArray(roundLabels) || roundLabels.length < roundCount || roundLabels.some((l) => typeof l !== 'string' || l.length > 30)) throw new StoreError('INVALID', '부 이름 오류');
  }
  return { changes, deletes };
}

class Store {
  constructor(backend, opts = {}) {
    this.backend = backend;
    this.now = opts.now || (() => new Date());
    this.log = opts.log || console;
    this.readOnly = null; // { reason, at, diffs }
    this._queue = Promise.resolve();
  }
  _lock(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }
  _assertWritable() {
    if (this.readOnly) throw new StoreError('READ_ONLY', `안전을 위해 저장이 잠겨 있습니다: ${this.readOnly.reason}`);
  }

  /* ---------- 읽기 ---------- */
  async load() {
    const tabs = await this.backend.readTabs(DATA_TABS);
    const sizes = sizeOf(tabs);
    const clean = {};
    for (const [t, rows] of Object.entries(tabs)) clean[t] = rows || [];
    const { dataset, warnings } = schema.decodeDataset(clean);
    let status = 'ok';
    let legacyInfo = null;
    if (!dataset.days.length) {
      const lt = await this.backend.readTabs([LEGACY_TAB]);
      const found = legacy.findLegacyInRows(lt[LEGACY_TAB]);
      if (found) { status = 'migration_pending'; legacyInfo = { days: found.obj.sessions.length, savedAt: found.savedAt }; }
      else status = 'empty';
    }
    return { dataset, sizes, warnings, status, legacyInfo };
  }

  async getData() {
    const r = await this.load();
    return {
      status: r.status,
      readOnly: this.readOnly ? this.readOnly.reason : null,
      warnings: r.warnings,
      legacy: r.legacyInfo,
      dataset: publicDataset(r.dataset),
    };
  }

  /* ---------- 쓰기 (공통) ---------- */
  async _write(dataset, prevSizes) {
    const v = schema.verifyRoundtrip(dataset);
    if (!v.ok) {
      this.log.error('[store] 쓰기 전 검증 실패', v.diffs.slice(0, 10));
      throw new StoreError('VERIFY_BEFORE_WRITE', '저장 전 검증에서 데이터가 달라지는 것이 발견되어 저장하지 않았습니다.', { diffs: v.diffs.slice(0, 20) });
    }
    await this.backend.ensureTabs(DATA_TABS);
    await this.backend.writeTabs(padTabs(v.tabs, prevSizes));
    const back = await this.backend.readTabs(DATA_TABS);
    const clean = {};
    for (const [t, rows] of Object.entries(back)) clean[t] = rows || [];
    const dec = schema.decodeDataset(clean);
    const diffs = schema.compareDatasets(dataset, dec.dataset);
    if (diffs.length) {
      this.readOnly = { reason: '저장 후 다시 읽은 데이터가 저장한 내용과 다릅니다. 관리자 확인이 필요합니다.', at: this.now().toISOString(), diffs: diffs.slice(0, 20) };
      this.log.error('[store] 쓰기 후 검증 실패 → 읽기 전용 전환', diffs.slice(0, 10));
      throw new StoreError('VERIFY_AFTER_WRITE', this.readOnly.reason, { diffs: diffs.slice(0, 20) });
    }
    return { sizes: sizeOf(back), dataset: dec.dataset };
  }

  /* ---------- 저장 (자동저장) ---------- */
  save(payload) {
    return this._lock(async () => {
      this._assertWritable();
      const { changes, deletes } = validateSavePayload(payload);
      const cur = await this.load();
      if (cur.status === 'migration_pending') throw new StoreError('MIGRATION_PENDING', '기존 데이터 이전이 아직 진행되지 않았습니다.');
      const curById = new Map(cur.dataset.days.map((d) => [d.id, d]));

      const conflicts = [];
      for (const c of changes) {
        const s = curById.get(c.id);
        if (s && s.version !== c.baseVersion) conflicts.push({ id: c.id, label: s.label, reason: 'modified' });
        if (!s && c.baseVersion !== 0) conflicts.push({ id: c.id, label: c.label, reason: 'deleted' });
      }
      for (const d of deletes) {
        const s = curById.get(d.id);
        if (s && s.version !== d.baseVersion) conflicts.push({ id: d.id, label: s.label, reason: 'modified' });
      }
      if (conflicts.length) throw new StoreError('CONFLICT', '다른 기기에서 먼저 수정된 날짜가 있습니다.', { conflicts });

      const nowIso = this.now().toISOString();
      const next = clone(cur.dataset);
      const delIds = new Set(deletes.map((d) => d.id).filter((id) => curById.has(id)));
      next.days = next.days.filter((d) => !delIds.has(d.id));
      const nextById = new Map(next.days.map((d) => [d.id, d]));
      const versions = {};
      for (const c of changes) {
        const ex = nextById.get(c.id);
        if (ex) {
          ex.label = c.label; ex.hidden = !!c.hidden; ex.state = Object.assign({}, c.state);
          ex.version = ex.version + 1; ex.updatedAt = nowIso;
          versions[c.id] = ex.version;
        } else {
          const d = { id: c.id, label: c.label, hidden: !!c.hidden, version: 1, updatedAt: nowIso, state: Object.assign({}, c.state) };
          next.days.push(d); nextById.set(d.id, d);
          versions[c.id] = 1;
        }
      }
      if (Array.isArray(payload.order)) {
        const pos = new Map();
        payload.order.forEach((id, i) => { if (!pos.has(id)) pos.set(id, i); });
        const orig = new Map(next.days.map((d, i) => [d.id, i]));
        next.days.sort((a, b) => {
          const pa = pos.has(a.id) ? pos.get(a.id) : 1e6 + orig.get(a.id);
          const pb = pos.has(b.id) ? pos.get(b.id) : 1e6 + orig.get(b.id);
          return pa - pb;
        });
      }
      if (payload.meta) {
        next.roundCount = payload.meta.roundCount;
        next.roundLabels = payload.meta.roundLabels.slice();
      }
      if (typeof payload.currentDayId === 'string' && nextById.has(payload.currentDayId)) next.currentDayId = payload.currentDayId;
      if (!nextById.has(next.currentDayId) && next.days.length) next.currentDayId = next.days[next.days.length - 1].id;
      if (!next.days.length) throw new StoreError('INVALID', '모든 날짜를 지울 수는 없습니다.');

      // 자동 백업: 오늘 첫 저장 전 / 날짜 삭제 전
      const today = kstDate(this.now());
      const hadData = cur.dataset.days.length > 0;
      if (hadData && cur.dataset.extraMeta.lastAutoBackupDate !== today) {
        await this._appendBackup(`자동 백업 (${today} 첫 저장 전)`, 'auto-daily', cur.dataset);
        next.extraMeta.lastAutoBackupDate = today;
      }
      if (hadData && delIds.size) {
        const names = cur.dataset.days.filter((d) => delIds.has(d.id)).map((d) => d.label).join(', ');
        await this._appendBackup(`자동 백업 (삭제 전: ${names})`.slice(0, 200), 'auto-before-delete', cur.dataset);
      }

      const written = await this._write(next, cur.sizes);
      return {
        ok: true,
        versions,
        deleted: [...delIds],
        days: written.dataset.days.map((d) => ({ id: d.id, version: d.version })),
        roundCount: written.dataset.roundCount,
        roundLabels: written.dataset.roundLabels,
      };
    });
  }

  /* ---------- 백업 ---------- */
  async _appendBackup(name, kind, datasetOrRaw) {
    let json;
    let dayCount;
    if (typeof datasetOrRaw === 'string') {
      json = datasetOrRaw;
      try { const o = JSON.parse(json); dayCount = (o.sessions || o.days || []).length; } catch (e) { dayCount = ''; }
    } else {
      const ds = datasetOrRaw;
      json = JSON.stringify({ format: 'holdem-ledger-dataset', version: 1, savedAt: this.now().toISOString(), ...publicDataset(ds), extraMeta: undefined });
      dayCount = ds.days.length;
    }
    const chunks = [];
    for (let i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
    const id = newBackupId();
    const lt = await this.backend.readTabs([BACKUP_TAB]);
    if (!lt[BACKUP_TAB] || lt[BACKUP_TAB].length === 0) {
      await this.backend.ensureTabs([BACKUP_TAB]);
      await this.backend.writeTabs({ [BACKUP_TAB]: [BACKUP_HEADERS] });
    }
    await this.backend.appendRow(BACKUP_TAB, [id, this.now().toISOString(), String(name).slice(0, 200), kind, dayCount, ...chunks]);
    return id;
  }

  createBackup(name) {
    return this._lock(async () => {
      const cur = await this.load();
      if (!cur.dataset.days.length) throw new StoreError('INVALID', '백업할 데이터가 없습니다.');
      const id = await this._appendBackup(name || '수동 백업', 'manual', cur.dataset);
      return { ok: true, id };
    });
  }

  async _readBackups() {
    const lt = await this.backend.readTabs([BACKUP_TAB]);
    const rows = lt[BACKUP_TAB] || [];
    return rows.slice(1).filter((r) => r && r[0]).map((r) => ({
      id: String(r[0]),
      createdAt: schema.fromCell(r[1]),
      name: schema.fromCell(r[2]),
      kind: schema.fromCell(r[3]),
      dayCount: schema.fromCell(r[4]),
      json: r.slice(5).map(schema.fromCell).join(''),
    }));
  }
  async listBackups() {
    const list = await this._readBackups();
    return list.map(({ json, ...rest }) => ({ ...rest, size: json.length })).reverse();
  }
  _backupToDataset(b) {
    let obj;
    try { obj = JSON.parse(b.json); } catch (e) { throw new StoreError('INVALID', '백업 데이터를 읽을 수 없습니다.'); }
    if (obj && obj.format === 'holdem-ledger-dataset') {
      return { days: obj.days, roundCount: obj.roundCount, roundLabels: obj.roundLabels, currentDayId: obj.currentDayId || '', extraMeta: {} };
    }
    if (legacy.isLegacyData(obj)) return legacy.legacyToDataset(obj, { now: this.now().toISOString() });
    throw new StoreError('INVALID', '알 수 없는 백업 형식입니다.');
  }
  restoreBackup(id) {
    return this._lock(async () => {
      this._assertWritable();
      const list = await this._readBackups();
      const b = list.find((x) => x.id === id);
      if (!b) throw new StoreError('NOT_FOUND', '백업을 찾을 수 없습니다.');
      const snap = this._backupToDataset(b);
      if (!snap.days || !snap.days.length) throw new StoreError('INVALID', '백업에 날짜가 없습니다.');
      snap.days.forEach((d, i) => validateState(d.state || {}, `백업 ${i + 1}번째 날짜`));
      const cur = await this.load();
      if (cur.dataset.days.length) await this._appendBackup(`자동 백업 (복원 전: ${b.name})`.slice(0, 200), 'auto-before-restore', cur.dataset);
      const curVer = new Map(cur.dataset.days.map((d) => [d.id, d.version]));
      const nowIso = this.now().toISOString();
      const next = {
        days: snap.days.map((d) => ({
          id: d.id, label: d.label, hidden: !!d.hidden, state: Object.assign({}, d.state || {}),
          version: Math.max(d.version || 0, curVer.get(d.id) || 0) + 1, updatedAt: nowIso,
        })),
        roundCount: snap.roundCount, roundLabels: snap.roundLabels, currentDayId: snap.currentDayId,
        extraMeta: Object.assign({}, cur.dataset.extraMeta),
      };
      if (!next.days.some((d) => d.id === next.currentDayId)) next.currentDayId = next.days[next.days.length - 1].id;
      const written = await this._write(next, cur.sizes);
      return { ok: true, dataset: publicDataset(written.dataset) };
    });
  }
  deleteBackup(id) {
    return this._lock(async () => {
      const n = await this.backend.deleteRowsWhere(BACKUP_TAB, 0, id);
      if (!n) throw new StoreError('NOT_FOUND', '백업을 찾을 수 없습니다.');
      return { ok: true };
    });
  }

  /* ---------- 기존 데이터 이전 ---------- */
  async _legacySource(sourceText) {
    if (sourceText && String(sourceText).trim()) {
      const raw = String(sourceText).trim();
      return { raw, obj: legacy.parseLegacyJson(raw), from: '직접 붙여넣은 JSON', savedAt: '' };
    }
    const lt = await this.backend.readTabs([LEGACY_TAB]);
    const found = legacy.findLegacyInRows(lt[LEGACY_TAB]);
    if (!found) throw new StoreError('NOT_FOUND', "기존 'latest' 탭에서 데이터를 찾지 못했습니다.");
    return { raw: found.raw, obj: found.obj, from: `latest 탭 ${found.row}행`, savedAt: found.savedAt };
  }
  _summarize(ds) {
    return ds.days.map((d) => {
      const s = calc.computeSettlement(d.state, { roundCount: ds.roundCount, roundLabels: ds.roundLabels });
      const rounds = Object.keys(s.roundTotals).filter((r) => s.roundTotals[r] > 0).length;
      return {
        label: d.label, hidden: d.hidden, participants: s.n, values: Object.keys(d.state).length,
        roundsWithBuyin: rounds, totalBuyin: Object.values(s.roundTotals).reduce((a, b) => a + b, 0), check: s.grandCheck,
      };
    });
  }
  async migrationPreview(sourceText) {
    const src = await this._legacySource(sourceText);
    const ds = legacy.legacyToDataset(src.obj, { now: this.now().toISOString() });
    const v = schema.verifyRoundtrip(ds);
    const decoded = schema.decodeDataset(schema.simulateSheets(v.tabs)).dataset;
    const cmp = legacy.compareLegacyWithDataset(src.obj, decoded);
    const cur = await this.load();
    return {
      source: { from: src.from, savedAt: src.savedAt, chars: src.raw.length },
      days: this._summarize(ds),
      checkedValues: cmp.checkedValues,
      diffs: [...v.diffs, ...cmp.diffs].slice(0, 50),
      ok: v.ok && cmp.diffs.length === 0,
      alreadyMigrated: cur.dataset.days.length > 0,
      rowsToWrite: Object.fromEntries(Object.entries(v.tabs).map(([t, r]) => [t, r.length - 1])),
    };
  }
  migrationApply(sourceText) {
    return this._lock(async () => {
      this._assertWritable();
      const cur = await this.load();
      if (cur.dataset.days.length) throw new StoreError('ALREADY_MIGRATED', '새 구조에 이미 데이터가 있어 이전하지 않았습니다. (덮어쓰기 방지)');
      const src = await this._legacySource(sourceText);
      const nowIso = this.now().toISOString();
      const ds = legacy.legacyToDataset(src.obj, { now: nowIso });
      ds.extraMeta = { migratedAt: nowIso, migratedFrom: src.from };
      const pre = schema.verifyRoundtrip(ds);
      const preCmp = legacy.compareLegacyWithDataset(src.obj, schema.decodeDataset(schema.simulateSheets(pre.tabs)).dataset);
      if (!pre.ok || preCmp.diffs.length) {
        throw new StoreError('VERIFY_BEFORE_WRITE', '이전 전 검증에서 차이가 발견되어 중단했습니다. (시트는 변경되지 않음)', { diffs: [...pre.diffs, ...preCmp.diffs].slice(0, 20) });
      }
      // 1) 원본 JSON을 글자 그대로 백업
      const backupId = await this._appendBackup('기존 데이터 원본 (이전 직전 latest)', 'migration-source', src.raw);
      // 2) 새 구조로 쓰기 + 다시 읽어 검증
      let written;
      try {
        written = await this._write(ds, cur.sizes);
      } catch (e) {
        throw e;
      }
      const cmp = legacy.compareLegacyWithDataset(src.obj, written.dataset);
      if (cmp.diffs.length) {
        // 되돌리기: 새 탭을 머리글만 남기고 비움 (기존 latest/history는 처음부터 건드리지 않음)
        try { await this._write(Object.assign(emptyDataset(), { extraMeta: {} }), written.sizes); } catch (e2) { /* 읽기전용 전환됨 */ }
        throw new StoreError('VERIFY_AFTER_WRITE', '이전 후 검증에서 차이가 발견되어 되돌렸습니다.', { diffs: cmp.diffs.slice(0, 20) });
      }
      return {
        ok: true,
        days: written.dataset.days.length,
        checkedValues: cmp.checkedValues,
        diffs: [],
        backupId,
        source: { from: src.from, savedAt: src.savedAt },
      };
    });
  }

  // 관리자용: 현재 새 구조 데이터 점검
  async integrityCheck() {
    const r = await this.load();
    const v = schema.verifyRoundtrip(r.dataset);
    return {
      status: r.status,
      days: r.dataset.days.length,
      values: r.dataset.days.reduce((a, d) => a + Object.keys(d.state).length, 0),
      warnings: r.warnings,
      roundtripOk: v.ok,
      diffs: v.diffs.slice(0, 20),
      readOnly: this.readOnly,
    };
  }
  unlockReadOnly() { this.readOnly = null; }
}

function publicDataset(ds) {
  return {
    days: ds.days.map((d) => ({ id: d.id, label: d.label, hidden: !!d.hidden, version: d.version, updatedAt: d.updatedAt, state: d.state })),
    roundCount: ds.roundCount,
    roundLabels: ds.roundLabels.slice(0, Math.max(ds.roundCount, 1)),
    currentDayId: ds.currentDayId,
  };
}

module.exports = { Store, StoreError, padTabs, sizeOf, emptyDataset };
