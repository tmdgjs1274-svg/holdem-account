'use strict';
/*
 * 예전 구조(latest 탭 한 칸에 전체 JSON)를 읽어 새 구조(dataset)로 바꾸고, 둘이 완전히 같은지 비교합니다.
 * 예전 탭(latest/history)은 읽기만 하고 절대 쓰지 않습니다.
 */
const { fromCell, compareStates } = require('./schema');
const { newDayId } = require('./ids');

function isLegacyData(obj) {
  return !!obj && typeof obj === 'object' && Array.isArray(obj.sessions) && obj.sessions.length > 0;
}

function parseLegacyJson(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    const err = new Error('기존 데이터(JSON)를 해석할 수 없습니다: ' + e.message);
    err.code = 'LEGACY_PARSE';
    throw err;
  }
  validateLegacy(obj);
  return obj;
}

function validateLegacy(obj) {
  const fail = (m) => { const e = new Error('기존 데이터 형식이 올바르지 않습니다: ' + m); e.code = 'LEGACY_INVALID'; throw e; };
  if (!isLegacyData(obj)) fail('sessions 목록이 없습니다.');
  obj.sessions.forEach((s, i) => {
    if (!s || typeof s !== 'object') fail(`${i + 1}번째 날짜가 비어있습니다.`);
    if (s.state !== null && s.state !== undefined && typeof s.state !== 'object') fail(`${i + 1}번째 날짜의 state 형식 오류`);
    if (s.state) {
      for (const [k, v] of Object.entries(s.state)) {
        if (typeof v !== 'string') fail(`${i + 1}번째 날짜의 ${k} 값이 문자열이 아닙니다.`);
      }
    }
  });
}

// latest 탭의 값(2차원 배열)에서 가장 아래쪽 행의 JSON을 찾습니다.
function findLegacyInRows(rows) {
  if (!rows) return null;
  for (let r = rows.length - 1; r >= 0; r--) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = fromCell(row[c]).trim();
      if (v.startsWith('{') && v.includes('"sessions"')) {
        let obj;
        try { obj = JSON.parse(v); } catch (e) { continue; }
        if (!isLegacyData(obj)) continue;
        const savedAt = c > 0 ? fromCell(row[0]) : '';
        return { raw: v, obj, row: r + 1, col: c + 1, savedAt };
      }
    }
  }
  return null;
}

function legacyToDataset(obj, opts = {}) {
  validateLegacy(obj);
  const now = opts.now || new Date().toISOString();
  const usedIds = new Set();
  const days = obj.sessions.map((s) => {
    let id;
    do { id = newDayId(); } while (usedIds.has(id));
    usedIds.add(id);
    return {
      id,
      label: typeof s.label === 'string' && s.label ? s.label : '',
      hidden: !!s.hidden,
      version: 1,
      updatedAt: now,
      state: Object.assign({}, s.state || {}),
    };
  });
  let idx = Number.isInteger(obj.currentSessionIndex) ? obj.currentSessionIndex : days.length - 1;
  idx = Math.min(Math.max(idx, 0), days.length - 1);
  const roundLabels = Array.isArray(obj.roundLabels) && obj.roundLabels.length ? obj.roundLabels.map(String) : ['1부', '2부', '3부'];
  const roundCount = Number.isInteger(obj.roundCount) && obj.roundCount >= 1 ? obj.roundCount : Math.max(3, roundLabels.length);
  return { days, roundCount, roundLabels, currentDayId: days[idx].id, extraMeta: {} };
}

// 새 구조 → 예전 구조 모양 (다운로드/예전 HTML 호환용)
function datasetToLegacy(ds) {
  const idx = Math.max(0, ds.days.findIndex((d) => d.id === ds.currentDayId));
  return {
    sessions: ds.days.map((d) => ({ label: d.label, state: Object.assign({}, d.state), hidden: !!d.hidden })),
    currentSessionIndex: idx,
    roundCount: ds.roundCount,
    roundLabels: ds.roundLabels.slice(0, ds.roundCount),
  };
}

// 예전 JSON과 새 구조를 날짜별·값별로 비교 (값 하나라도 다르면 목록에 나옵니다)
function compareLegacyWithDataset(legacy, ds) {
  const diffs = [];
  const L = legacy.sessions;
  if (L.length !== ds.days.length) diffs.push(`날짜 개수 다름: 기존 ${L.length}개 / 새 구조 ${ds.days.length}개`);
  const n = Math.min(L.length, ds.days.length);
  let keys = 0;
  for (let i = 0; i < n; i++) {
    const a = L[i], b = ds.days[i];
    const tag = `[${i + 1}] ${a.label}`;
    if ((a.label || '') !== b.label) diffs.push(`${tag}: 날짜명 다름 → "${b.label}"`);
    if (!!a.hidden !== !!b.hidden) diffs.push(`${tag}: 숨김 여부 다름`);
    const sa = a.state || {};
    keys += Object.keys(sa).length;
    diffs.push(...compareStates(sa, b.state || {}, tag));
  }
  const legacyIdx = Number.isInteger(legacy.currentSessionIndex) ? legacy.currentSessionIndex : null;
  if (legacyIdx !== null && ds.days[legacyIdx] && ds.days[legacyIdx].id !== ds.currentDayId) diffs.push('마지막으로 보던 날짜가 다름');
  if (Number.isInteger(legacy.roundCount) && legacy.roundCount !== ds.roundCount) diffs.push(`부 개수 다름: ${legacy.roundCount} → ${ds.roundCount}`);
  if (Array.isArray(legacy.roundLabels)) {
    const a = legacy.roundLabels.map(String), b = ds.roundLabels.slice(0, a.length);
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push('부 이름 다름');
  }
  return { diffs, checkedValues: keys, days: n };
}

module.exports = { isLegacyData, parseLegacyJson, validateLegacy, findLegacyInRows, legacyToDataset, datasetToLegacy, compareLegacyWithDataset };
