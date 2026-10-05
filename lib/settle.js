'use strict';
/*
 * 정산 이력 탭 구조
 *  settle_runs    : 정산 1건 = 1행 (정산명, 상태(완료/취소), 포함 날짜 등)
 *  settle_totals  : 정산 × 이름 = 1행 (이름별 합계금액)
 *  settle_details : 정산 × 날짜 × 참가자 = 1행 (날짜별 최종 처리금액)
 * 정산 이력은 "저장한 그 시점의 금액"을 그대로 보관합니다. (나중에 날짜 데이터를 고쳐도 이력 금액은 바뀌지 않음)
 */
const { fromCell, toCell } = require('./schema');

const SETTLE_TABS = ['settle_runs', 'settle_totals', 'settle_details'];
const SETTLE_HEADERS = {
  settle_runs: ['정산ID', '정산일시', '정산명', '상태', '날짜수', 'day_ids', '날짜명(참고)', '인원수', '합계확인', '취소일시'],
  settle_totals: ['정산ID', '정산명(참고)', '이름', '합계금액', '참여 날짜 수'],
  settle_details: ['정산ID', 'day_id', '날짜명(참고)', '번호', '이름', '최종처리금액'],
};
const REQUIRED = {
  settle_runs: ['정산ID', '정산일시', '정산명', '상태', 'day_ids', '날짜명(참고)', '합계확인', '취소일시'],
  settle_totals: ['정산ID', '이름', '합계금액', '참여 날짜 수'],
  settle_details: ['정산ID', 'day_id', '날짜명(참고)', '번호', '이름', '최종처리금액'],
};
const STATUS_DONE = '완료';
const STATUS_CANCELED = '취소';

const num = (c) => { const s = fromCell(c).trim(); const n = Number(s); return s !== '' && Number.isFinite(n) ? n : 0; };

function encodeRuns(runs) {
  const out = {};
  for (const t of SETTLE_TABS) out[t] = [SETTLE_HEADERS[t]];
  for (const r of runs) {
    out.settle_runs.push([r.id, r.createdAt, r.name, r.status, r.dayIds.length, r.dayIds.join(','), r.dayLabels.join(' / '),
      r.totals.length, r.checkSum, r.canceledAt || '']);
    for (const t of r.totals) out.settle_totals.push([r.id, r.name, t.name, t.total, t.days]);
    for (const d of r.details) out.settle_details.push([r.id, d.dayId, d.label, d.slot, d.name, d.amount]);
  }
  // 이름·날짜명은 항상 글자로 (숫자처럼 생긴 이름도 그대로)
  return out;
}

function index(name, rows) {
  if (!rows || !rows.length) return { col: {}, rows: [] };
  const header = rows[0].map((c) => fromCell(c).trim());
  const col = {};
  header.forEach((h, i) => { if (h && !(h in col)) col[h] = i; });
  const missing = REQUIRED[name].filter((h) => !(h in col));
  if (missing.length) {
    const e = new Error(`[${name}] 탭에 필요한 머리글이 없습니다: ${missing.join(', ')}`);
    e.code = 'SCHEMA_HEADER_MISSING';
    throw e;
  }
  return { col, rows: rows.slice(1) };
}

function decodeRuns(tabs) {
  const R = index('settle_runs', tabs.settle_runs);
  const T = index('settle_totals', tabs.settle_totals);
  const D = index('settle_details', tabs.settle_details);
  const runs = [];
  const byId = new Map();
  for (const row of R.rows) {
    const id = fromCell(row[R.col['정산ID']]).trim();
    if (!id || byId.has(id)) continue;
    const dayIdsCell = fromCell(row[R.col.day_ids]).trim();
    const run = {
      id,
      createdAt: fromCell(row[R.col['정산일시']]),
      name: fromCell(row[R.col['정산명']]),
      status: fromCell(row[R.col['상태']]).trim() === STATUS_CANCELED ? STATUS_CANCELED : STATUS_DONE,
      dayIds: dayIdsCell ? dayIdsCell.split(',').map((s) => s.trim()).filter(Boolean) : [],
      dayLabels: fromCell(row[R.col['날짜명(참고)']]) ? fromCell(row[R.col['날짜명(참고)']]).split(' / ') : [],
      checkSum: num(row[R.col['합계확인']]),
      canceledAt: fromCell(row[R.col['취소일시']]),
      totals: [],
      details: [],
    };
    runs.push(run); byId.set(id, run);
  }
  for (const row of T.rows) {
    const run = byId.get(fromCell(row[T.col['정산ID']]).trim());
    if (!run) continue;
    run.totals.push({ name: fromCell(row[T.col['이름']]), total: num(row[T.col['합계금액']]), days: num(row[T.col['참여 날짜 수']]) });
  }
  for (const row of D.rows) {
    const run = byId.get(fromCell(row[D.col['정산ID']]).trim());
    if (!run) continue;
    run.details.push({
      dayId: fromCell(row[D.col.day_id]).trim(), label: fromCell(row[D.col['날짜명(참고)']]),
      slot: num(row[D.col['번호']]), name: fromCell(row[D.col['이름']]), amount: num(row[D.col['최종처리금액']]),
    });
  }
  return runs;
}

function compareRuns(a, b) {
  const norm = (runs) => JSON.stringify(runs.map((r) => ({
    id: r.id, createdAt: r.createdAt, name: r.name, status: r.status, dayIds: r.dayIds, checkSum: r.checkSum, canceledAt: r.canceledAt || '',
    totals: r.totals.map((t) => [t.name, t.total, t.days]), details: r.details.map((d) => [d.dayId, d.slot, d.name, d.amount]),
  })));
  return norm(a) === norm(b);
}

module.exports = { SETTLE_TABS, SETTLE_HEADERS, STATUS_DONE, STATUS_CANCELED, encodeRuns, decodeRuns, compareRuns, toCell };
