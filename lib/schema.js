'use strict';
/*
 * 구글 시트 DB 구조 정의 + 변환기
 *
 * 앱(화면)은 날짜마다 "state"라는 평평한 key→value(문자열) 묶음으로 데이터를 다룹니다.
 *   예) { "participantCount":"5", "p-name-1":"홍길동", "buyin-1-2-0":"2000", ... }
 * 이 파일은 그 state를 시트의 여러 탭(날짜/참가자/비율/부별 바이인/순위/바운티)으로 나눠 쓰고(encode),
 * 다시 읽어 원래 state로 되돌리는(decode) 일을 합니다.
 *
 * 무손실 보장 원칙
 *  1) 모든 값은 문자열로 되돌아옵니다. 숫자로 써도 되는 값은 "정확히 같은 문자열로 되돌아오는 경우"에만 숫자로 씁니다.
 *  2) 날짜 하나를 쓸 때마다, 시트에 쓴 결과를 다시 읽은 것처럼 되돌려보고(decode) 원본과 비교합니다.
 *     구조화된 칸으로 표현되지 않는 값(예상 밖의 key 등)이 하나라도 있으면 days 탭의 "보정데이터" 칸에 그대로 담아
 *     읽을 때 다시 적용합니다. → 어떤 입력이 와도 원본과 1글자도 다르지 않게 복원됩니다.
 *  3) 열은 위치가 아니라 머리글(1행) 이름으로 찾습니다. 시트에서 열 순서를 바꿔도 안전하고,
 *     필요한 머리글이 사라졌으면 추측하지 않고 오류를 냅니다.
 */

const calc = require('../public/js/calc.js');

const MAXP = 9;          // 최대 참가자 수
const SLOTS = 5;         // 바이인 + 리바인 4칸
const RANKS = 4;         // 등수 칸 수
const LEVELS = 4;        // 바운티 등급 수
const SCHEMA_VERSION = 1;

const H = {
  dayId: 'day_id',
  order: '순서',
  label: '날짜명',
  labelRef: '날짜명(참고)',
  hidden: '숨김',
  participantCount: '참가자수',
  bountyRatio: '바운티풀비율(%)',
  roundCount: '부 개수',
  version: '버전',
  updatedAt: '최종수정',
  patch: '보정데이터',
  slot: '번호',
  name: '이름',
  nameRef: '이름(참고)',
  joinedRef: '참여(참고)',
  rankNo: '순번',
  rankLabel: '등수명',
  rankLabelRef: '등수명(참고)',
  normalRatio: '일반게임비율(%)',
  bountyGameRatio: '바운티게임비율(%)',
  round: '부',
  roundLabelRef: '부명(참고)',
  gtype: '게임유형',
  buyinSlots: ['바이인', '리바인1', '리바인2', '리바인3', '리바인4'],
  buyinSumRef: '합계(참고)',
  winner: '참가자번호',
  winnerNameRef: '참가자(참고)',
  prizeRef: '상금(참고)',
  levelLabel: '등급명',
  levelRatio: '비율(%)',
  levelMax: '최대개수',
  levelCounts: Array.from({ length: MAXP }, (_, i) => `${i + 1}번`),
};

const TAB_HEADERS = {
  days: [H.dayId, H.order, H.label, H.hidden, H.participantCount, H.bountyRatio, H.roundCount, H.version, H.updatedAt, H.patch],
  participants: [H.dayId, H.labelRef, H.slot, H.name, H.joinedRef],
  ratios: [H.dayId, H.labelRef, H.rankNo, H.rankLabel, H.normalRatio, H.bountyGameRatio],
  rounds: [H.dayId, H.labelRef, H.round, H.roundLabelRef, H.gtype],
  buyins: [H.dayId, H.labelRef, H.round, H.slot, H.nameRef, ...H.buyinSlots, H.buyinSumRef],
  rank_results: [H.dayId, H.labelRef, H.round, H.rankNo, H.rankLabelRef, H.winner, H.winnerNameRef, H.prizeRef],
  bounty: [H.dayId, H.labelRef, H.round, H.rankNo, H.levelLabel, H.levelRatio, H.levelMax, ...H.levelCounts],
  meta: ['key', 'value'],
};
// settlement(최종 처리금액) 탭은 부 개수에 따라 머리글이 달라져서 encode 때 만듭니다. (계산 결과 기록용, 읽을 때는 사용하지 않음)
const DATA_TABS = ['days', 'participants', 'ratios', 'rounds', 'buyins', 'rank_results', 'bounty', 'settlement', 'meta'];
const BACKUP_TAB = 'backups';
const BACKUP_HEADERS = ['backup_id', '저장시각', '이름', '종류', '날짜수', '데이터(JSON, 오른쪽 칸으로 이어짐)'];

const GTYPE_TO_CELL = { bounty: '바운티', normal: '일반' };
const CELL_TO_GTYPE = { '바운티': 'bounty', '일반': 'normal' };

/* ---------------- 값 변환 ---------------- */

// 숫자로 써도 "읽었을 때 정확히 같은 문자열"이 되는 경우에만 숫자로 씁니다. (예: "3000" → 3000, "0050"·"1e3"은 문자열 그대로)
function toCell(v) {
  if (typeof v !== 'string') v = v === undefined || v === null ? '' : String(v);
  if (v === '') return '';
  const n = Number(v);
  if (Number.isFinite(n) && String(n) === v) return n;
  return v;
}
function textCell(v) {
  return v === undefined || v === null ? '' : String(v);
}
function fromCell(c) {
  if (c === undefined || c === null) return '';
  if (typeof c === 'number') return String(c);
  if (typeof c === 'boolean') return c ? 'TRUE' : 'FALSE';
  return String(c);
}
function intCell(c) {
  const s = fromCell(c).trim();
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

/* ---------------- state key 분류 ---------------- */

function classifyKey(key) {
  let m;
  if (key === 'participantCount') return { kind: 'day', field: 'participantCount' };
  if (key === 'bounty-ratio-input') return { kind: 'day', field: 'bountyRatio' };
  if (key === 'round-count') return { kind: 'day', field: 'roundCount' };
  if ((m = key.match(/^p-name-([1-9])$/))) return { kind: 'participant', i: +m[1] };
  if ((m = key.match(/^rank-label-([0-3])$/))) return { kind: 'ratio', idx: +m[1], field: 'label' };
  if ((m = key.match(/^rank-ratio-normal-([0-3])$/))) return { kind: 'ratio', idx: +m[1], field: 'normal' };
  if ((m = key.match(/^rank-ratio-([0-3])$/))) return { kind: 'ratio', idx: +m[1], field: 'bounty' };
  if ((m = key.match(/^gtype-([1-9]\d?)$/))) return { kind: 'round', r: +m[1] };
  if ((m = key.match(/^buyin-([1-9]\d?)-([1-9])-([0-4])$/))) return { kind: 'buyin', r: +m[1], i: +m[2], s: +m[3] };
  if ((m = key.match(/^rankwin-([1-9]\d?)-([0-3])$/))) return { kind: 'rank', r: +m[1], idx: +m[2] };
  if ((m = key.match(/^bl-(label|ratio|count)-([1-9]\d?)-([0-3])$/))) return { kind: 'level', r: +m[2], lv: +m[3], field: m[1] };
  if ((m = key.match(/^bg-([1-9]\d?)-([0-3])-([1-9])$/))) return { kind: 'level', r: +m[1], lv: +m[2], i: +m[3], field: 'count' + m[3] };
  return { kind: 'extra' };
}

/* ---------------- 날짜 1개 → 행들 ---------------- */

function sortNum(a, b) { return a - b; }

function encodeDayRows(day, order, ctx) {
  const st = day.state || {};
  const label = textCell(day.label);
  const has = (k) => Object.prototype.hasOwnProperty.call(st, k);
  const get = (k) => (has(k) ? st[k] : '');
  const names = (i) => {
    const v = get(`p-name-${i}`).trim();
    return v || `참가자${i}`;
  };
  const pcount = parseInt(get('participantCount'), 10) || 0;
  const s = ctx.settlement; // calc 결과 (참고 열 채우기용)

  const parts = new Set(), ratioIdx = new Set(), roundSet = new Set(), buyinKeys = new Map(), rankKeys = new Map(), levelKeys = new Map();
  const roundsPresent = new Set();
  for (const key of Object.keys(st)) {
    const c = classifyKey(key);
    if (c.kind === 'participant') parts.add(c.i);
    else if (c.kind === 'ratio') ratioIdx.add(c.idx);
    else if (c.kind === 'round') { roundSet.add(c.r); roundsPresent.add(c.r); }
    else if (c.kind === 'buyin') { buyinKeys.set(`${c.r}|${c.i}`, [c.r, c.i]); roundsPresent.add(c.r); }
    else if (c.kind === 'rank') { rankKeys.set(`${c.r}|${c.idx}`, [c.r, c.idx]); roundsPresent.add(c.r); }
    else if (c.kind === 'level') { levelKeys.set(`${c.r}|${c.lv}`, [c.r, c.lv]); roundsPresent.add(c.r); }
  }

  const rows = { participants: [], ratios: [], rounds: [], buyins: [], rank_results: [], bounty: [] };

  [...parts].sort(sortNum).forEach((i) => {
    rows.participants.push([day.id, label, i, textCell(get(`p-name-${i}`)), i <= pcount ? 'Y' : '']);
  });
  [...ratioIdx].sort(sortNum).forEach((idx) => {
    rows.ratios.push([day.id, label, idx + 1, textCell(get(`rank-label-${idx}`)),
      toCell(get(`rank-ratio-normal-${idx}`)), toCell(get(`rank-ratio-${idx}`))]);
  });
  [...roundSet].sort(sortNum).forEach((r) => {
    const g = get(`gtype-${r}`);
    rows.rounds.push([day.id, label, r, textCell(ctx.roundLabels[r - 1] || `${r}부`), GTYPE_TO_CELL[g] || textCell(g)]);
  });
  [...buyinKeys.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]).forEach(([r, i]) => {
    const vals = [];
    let sum = 0;
    for (let sl = 0; sl < SLOTS; sl++) {
      const v = get(`buyin-${r}-${i}-${sl}`);
      vals.push(toCell(v));
      sum += calc.buyinValue(v);
    }
    rows.buyins.push([day.id, label, r, i, names(i), ...vals, sum]);
  });
  [...rankKeys.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]).forEach(([r, idx]) => {
    const w = get(`rankwin-${r}-${idx}`);
    const wi = parseInt(w, 10);
    const rankLbl = get(`rank-label-${idx}`) || calc.DEFAULT_RANKS[idx].label;
    const prize = s && s.rankPrizes[r] ? Math.round(s.rankPrizes[r][idx]) : '';
    rows.rank_results.push([day.id, label, r, idx + 1, rankLbl, toCell(w),
      w && wi >= 1 && wi <= MAXP && String(wi) === w ? names(wi) : '', prize]);
  });
  [...levelKeys.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]).forEach(([r, lv]) => {
    const counts = [];
    for (let i = 1; i <= MAXP; i++) counts.push(toCell(get(`bg-${r}-${lv}-${i}`)));
    rows.bounty.push([day.id, label, r, lv + 1, textCell(get(`bl-label-${r}-${lv}`)),
      toCell(get(`bl-ratio-${r}-${lv}`)), toCell(get(`bl-count-${r}-${lv}`)), ...counts]);
  });

  const dayRow = [day.id, order, label, day.hidden ? 'Y' : 'N', toCell(get('participantCount')), toCell(get('bounty-ratio-input')),
    has('round-count') ? toCell(get('round-count')) : '', Number.isInteger(day.version) ? day.version : 0, textCell(day.updatedAt), ''];

  // 무손실 확인: 방금 만든 행을 "시트에서 읽은 것처럼" 되돌려 원본과 비교 → 다른 값은 보정데이터에 담습니다.
  const tabs = { days: [TAB_HEADERS.days, simulateRow(dayRow)] };
  for (const t of Object.keys(rows)) tabs[t] = [TAB_HEADERS[t], ...rows[t].map(simulateRow)];
  const decoded = decodeDayStateFromTabs(day.id, indexTabs(tabs), null).state;
  const patch = { set: {}, del: [] };
  for (const k of Object.keys(st)) {
    if (!Object.prototype.hasOwnProperty.call(decoded, k) || decoded[k] !== st[k]) patch.set[k] = st[k];
  }
  for (const k of Object.keys(decoded)) {
    if (!has(k)) patch.del.push(k);
  }
  if (Object.keys(patch.set).length || patch.del.length) {
    const p = {};
    if (Object.keys(patch.set).length) p.set = patch.set;
    if (patch.del.length) p.del = patch.del;
    dayRow[9] = JSON.stringify(p);
  }
  rows.days = [dayRow];
  return rows;
}

/* ---------------- 전체 dataset ↔ 탭 ---------------- */

function encodeDataset(dataset) {
  const roundCount = dataset.roundCount;
  const roundLabels = dataset.roundLabels;
  const out = {};
  for (const t of Object.keys(TAB_HEADERS)) if (t !== 'meta') out[t] = [TAB_HEADERS[t]];

  const stHeader = [H.dayId, H.labelRef, H.slot, '이름', '총 바이인'];
  const dayRc = (st) => { const v = st && Object.prototype.hasOwnProperty.call(st, 'round-count') ? String(st['round-count']) : ''; return /^[1-9]\d?$/.test(v) ? parseInt(v, 10) : roundCount; };
  const maxRounds = dataset.days.reduce((m, d) => Math.max(m, dayRc(d.state || {})), roundCount);
  for (let r = 1; r <= maxRounds; r++) {
    const l = roundLabels[r - 1] || `${r}부`;
    stHeader.push(`${l} 상금`, `${l} 바운티`);
  }
  stHeader.push('최종 처리금액');
  out.settlement = [stHeader];

  dataset.days.forEach((day, idx) => {
    const settlement = calc.computeSettlement(day.state || {}, { roundCount, roundLabels });
    const rows = encodeDayRows(day, idx + 1, { roundLabels, settlement });
    for (const t of Object.keys(rows)) out[t].push(...rows[t]);
    settlement.players.forEach((p) => {
      const row = [day.id, textCell(day.label), p.slot, p.name, p.buyin];
      p.rounds.forEach((rv) => row.push(rv.prize, rv.bounty));
      for (let r = p.rounds.length; r < maxRounds; r++) row.push('', ''); // 부가 적은 날짜는 빈칸
      row.push(p.total);
      out.settlement.push(row);
    });
  });

  const meta = [
    ['schemaVersion', SCHEMA_VERSION],
    ['roundCount', roundCount],
    ['roundLabels', JSON.stringify(roundLabels.slice(0, Math.max(roundCount, roundLabels.length)))],
    ['currentDayId', textCell(dataset.currentDayId)],
  ];
  for (const [k, v] of Object.entries(dataset.extraMeta || {})) meta.push([k, textCell(v)]);
  out.meta = [TAB_HEADERS.meta, ...meta];
  return out;
}

// 시트 API가 돌려주는 모양으로 바꾸기: 빈 문자열은 빈 칸(미반환), 각 행의 끝쪽 빈 칸은 잘림
function simulateRow(row) {
  const r = row.map((c) => (c === '' || c === undefined || c === null ? undefined : c));
  while (r.length && r[r.length - 1] === undefined) r.pop();
  return r;
}
function simulateSheets(tabs) {
  const out = {};
  for (const [t, rows] of Object.entries(tabs)) {
    const rr = rows.map(simulateRow);
    while (rr.length && rr[rr.length - 1].length === 0) rr.pop();
    out[t] = rr;
  }
  return out;
}

// 탭 하나: 1행 머리글로 열 위치를 찾고, 데이터 행을 객체로
function indexTab(name, rows, required) {
  if (!rows || rows.length === 0) return { name, header: [], col: {}, rows: [] };
  const header = (rows[0] || []).map((c) => fromCell(c).trim());
  const col = {};
  header.forEach((h, i) => { if (h && !(h in col)) col[h] = i; });
  if (required) {
    const missing = required.filter((h) => !(h in col));
    if (missing.length) {
      const e = new Error(`[${name}] 탭에 필요한 머리글이 없습니다: ${missing.join(', ')}`);
      e.code = 'SCHEMA_HEADER_MISSING';
      throw e;
    }
  }
  return { name, header, col, rows: rows.slice(1) };
}
const REQUIRED = {
  days: [H.dayId, H.order, H.label, H.hidden, H.participantCount, H.bountyRatio, H.version, H.updatedAt, H.patch],
  participants: [H.dayId, H.slot, H.name],
  ratios: [H.dayId, H.rankNo, H.rankLabel, H.normalRatio, H.bountyGameRatio],
  rounds: [H.dayId, H.round, H.gtype],
  buyins: [H.dayId, H.round, H.slot, ...H.buyinSlots],
  rank_results: [H.dayId, H.round, H.rankNo, H.winner],
  bounty: [H.dayId, H.round, H.rankNo, H.levelLabel, H.levelRatio, H.levelMax, ...H.levelCounts],
  meta: ['key', 'value'],
};
function indexTabs(tabs) {
  const idx = {};
  for (const t of Object.keys(REQUIRED)) {
    const rows = tabs[t];
    idx[t] = indexTab(t, rows, rows && rows.length ? REQUIRED[t] : null);
  }
  // day_id별로 행 묶기
  idx.byDay = {};
  for (const t of ['participants', 'ratios', 'rounds', 'buyins', 'rank_results', 'bounty']) {
    const T = idx[t];
    const dc = T.col[H.dayId];
    for (const row of T.rows) {
      const id = fromCell(row[dc]).trim();
      if (!id) continue;
      (idx.byDay[id] = idx.byDay[id] || {});
      (idx.byDay[id][t] = idx.byDay[id][t] || []).push(row);
    }
  }
  return idx;
}

function decodeDayStateFromTabs(dayId, idx, warnings) {
  const st = {};
  const warn = (m) => { if (warnings) warnings.push(m); };
  const g = idx.byDay[dayId] || {};
  const cell = (T, row, h) => fromCell(row[idx[T].col[h]]);

  // days 행
  const D = idx.days;
  let dayRow = null;
  for (const row of D.rows) {
    if (fromCell(row[D.col[H.dayId]]).trim() === dayId) { dayRow = row; break; }
  }
  let patch = null;
  if (dayRow) {
    st.participantCount = cell('days', dayRow, H.participantCount);
    st['bounty-ratio-input'] = cell('days', dayRow, H.bountyRatio);
    // 부 개수(날짜별) — 이 열이 없는 예전 시트이거나 칸이 비어있으면 key 없음(= 기본 부 개수)
    if (H.roundCount in idx.days.col) {
      const rc = cell('days', dayRow, H.roundCount);
      if (rc !== '') st['round-count'] = rc;
    }
    const p = cell('days', dayRow, H.patch).trim();
    if (p) {
      try { patch = JSON.parse(p); } catch (e) {
        const err = new Error(`[days] ${dayId}의 보정데이터를 읽을 수 없습니다.`);
        err.code = 'SCHEMA_PATCH_INVALID';
        throw err;
      }
    }
  }
  const seen = new Set();
  const once = (k, t) => { if (seen.has(k)) warn(`[${t}] ${dayId}: 같은 항목이 두 번 있습니다 (${k}) — 나중 행 사용`); seen.add(k); };

  for (const row of g.participants || []) {
    const i = intCell(row[idx.participants.col[H.slot]]);
    if (!(i >= 1 && i <= MAXP)) { warn(`[participants] ${dayId}: 번호가 올바르지 않은 행 무시`); continue; }
    once(`p${i}`, 'participants');
    st[`p-name-${i}`] = cell('participants', row, H.name);
  }
  for (const row of g.ratios || []) {
    const k = intCell(row[idx.ratios.col[H.rankNo]]);
    if (!(k >= 1 && k <= RANKS)) { warn(`[ratios] ${dayId}: 순번이 올바르지 않은 행 무시`); continue; }
    const r = k - 1;
    once(`r${r}`, 'ratios');
    st[`rank-label-${r}`] = cell('ratios', row, H.rankLabel);
    st[`rank-ratio-normal-${r}`] = cell('ratios', row, H.normalRatio);
    st[`rank-ratio-${r}`] = cell('ratios', row, H.bountyGameRatio);
  }
  for (const row of g.rounds || []) {
    const r = intCell(row[idx.rounds.col[H.round]]);
    if (!(r >= 1 && r <= 99)) { warn(`[rounds] ${dayId}: 부 번호가 올바르지 않은 행 무시`); continue; }
    once(`g${r}`, 'rounds');
    const v = cell('rounds', row, H.gtype);
    st[`gtype-${r}`] = CELL_TO_GTYPE[v] || v;
  }
  for (const row of g.buyins || []) {
    const r = intCell(row[idx.buyins.col[H.round]]);
    const i = intCell(row[idx.buyins.col[H.slot]]);
    if (!(r >= 1 && r <= 99 && i >= 1 && i <= MAXP)) { warn(`[buyins] ${dayId}: 부/번호가 올바르지 않은 행 무시`); continue; }
    once(`b${r}-${i}`, 'buyins');
    H.buyinSlots.forEach((h, sl) => { st[`buyin-${r}-${i}-${sl}`] = cell('buyins', row, h); });
  }
  for (const row of g.rank_results || []) {
    const r = intCell(row[idx.rank_results.col[H.round]]);
    const k = intCell(row[idx.rank_results.col[H.rankNo]]);
    if (!(r >= 1 && r <= 99 && k >= 1 && k <= RANKS)) { warn(`[rank_results] ${dayId}: 부/순번이 올바르지 않은 행 무시`); continue; }
    once(`w${r}-${k}`, 'rank_results');
    st[`rankwin-${r}-${k - 1}`] = cell('rank_results', row, H.winner);
  }
  for (const row of g.bounty || []) {
    const r = intCell(row[idx.bounty.col[H.round]]);
    const k = intCell(row[idx.bounty.col[H.rankNo]]);
    if (!(r >= 1 && r <= 99 && k >= 1 && k <= LEVELS)) { warn(`[bounty] ${dayId}: 부/순번이 올바르지 않은 행 무시`); continue; }
    const lv = k - 1;
    once(`l${r}-${lv}`, 'bounty');
    st[`bl-label-${r}-${lv}`] = cell('bounty', row, H.levelLabel);
    st[`bl-ratio-${r}-${lv}`] = cell('bounty', row, H.levelRatio);
    st[`bl-count-${r}-${lv}`] = cell('bounty', row, H.levelMax);
    H.levelCounts.forEach((h, j) => { st[`bg-${r}-${lv}-${j + 1}`] = cell('bounty', row, h); });
  }

  if (patch) {
    if (patch.set && typeof patch.set === 'object') {
      for (const [k, v] of Object.entries(patch.set)) st[k] = String(v);
    }
    if (Array.isArray(patch.del)) for (const k of patch.del) delete st[k];
  }
  return { state: st, dayRow };
}

function decodeDataset(tabs) {
  const warnings = [];
  const idx = indexTabs(tabs);
  const D = idx.days;
  const days = [];
  const seenIds = new Set();
  D.rows.forEach((row, rowNo) => {
    const id = fromCell(row[D.col[H.dayId]]).trim();
    if (!id) return; // 빈 행
    if (seenIds.has(id)) { warnings.push(`[days] day_id 중복: ${id} — 첫 행만 사용`); return; }
    seenIds.add(id);
    const order = Number(fromCell(row[D.col[H.order]]));
    const { state } = decodeDayStateFromTabs(id, idx, warnings);
    days.push({
      id,
      label: fromCell(row[D.col[H.label]]),
      hidden: fromCell(row[D.col[H.hidden]]).trim().toUpperCase() === 'Y',
      version: intCell(row[D.col[H.version]]) || 0,
      updatedAt: fromCell(row[D.col[H.updatedAt]]),
      state,
      _order: Number.isFinite(order) ? order : 1e9 + rowNo,
      _row: rowNo,
    });
  });
  days.sort((a, b) => a._order - b._order || a._row - b._row);
  days.forEach((d) => { delete d._order; delete d._row; });

  for (const id of Object.keys(idx.byDay)) {
    if (!seenIds.has(id)) warnings.push(`days 탭에 없는 day_id(${id})의 행이 있습니다 — 무시`);
  }

  const meta = {};
  const M = idx.meta;
  for (const row of M.rows) {
    const k = fromCell(row[M.col.key]).trim();
    if (k) meta[k] = fromCell(row[M.col.value]);
  }
  let roundLabels = ['1부', '2부', '3부'];
  try {
    const parsed = meta.roundLabels ? JSON.parse(meta.roundLabels) : null;
    if (Array.isArray(parsed)) roundLabels = parsed.map(String);
  } catch (e) { warnings.push('meta.roundLabels를 읽을 수 없어 기본값 사용'); }
  let roundCount = parseInt(meta.roundCount, 10);
  if (!(roundCount >= 1)) roundCount = Math.max(3, roundLabels.length);

  const extraMeta = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!['schemaVersion', 'roundCount', 'roundLabels', 'currentDayId'].includes(k)) extraMeta[k] = v;
  }
  return {
    dataset: { days, roundCount, roundLabels, currentDayId: meta.currentDayId || '', extraMeta },
    warnings,
    schemaVersion: meta.schemaVersion ? parseInt(meta.schemaVersion, 10) : null,
  };
}

/* ---------------- 비교 / 검증 ---------------- */

function compareDatasets(a, b, opts = {}) {
  const diffs = [];
  const push = (m) => { if (diffs.length < 200) diffs.push(m); };
  if (a.days.length !== b.days.length) push(`날짜 개수 다름: ${a.days.length} vs ${b.days.length}`);
  const n = Math.min(a.days.length, b.days.length);
  for (let i = 0; i < n; i++) {
    const x = a.days[i], y = b.days[i];
    const tag = `[${i + 1}] ${x.label}`;
    if (x.id !== y.id) push(`${tag}: id 다름 (${x.id} vs ${y.id})`);
    if (x.label !== y.label) push(`${tag}: 날짜명 다름 (${y.label})`);
    if (!!x.hidden !== !!y.hidden) push(`${tag}: 숨김 다름`);
    if (!opts.ignoreVersions) {
      if ((x.version || 0) !== (y.version || 0)) push(`${tag}: 버전 다름 (${x.version} vs ${y.version})`);
      if ((x.updatedAt || '') !== (y.updatedAt || '')) push(`${tag}: 최종수정 다름`);
    }
    diffs.push(...compareStates(x.state || {}, y.state || {}, tag).slice(0, Math.max(0, 200 - diffs.length)));
  }
  if (a.roundCount !== b.roundCount) push(`부 개수 다름: ${a.roundCount} vs ${b.roundCount}`);
  if (JSON.stringify(a.roundLabels.slice(0, a.roundCount)) !== JSON.stringify(b.roundLabels.slice(0, b.roundCount))) push('부 이름 다름');
  if ((a.currentDayId || '') !== (b.currentDayId || '')) push('현재 날짜 다름');
  return diffs;
}
function compareStates(x, y, tag) {
  const diffs = [];
  for (const k of Object.keys(x)) {
    if (!Object.prototype.hasOwnProperty.call(y, k)) diffs.push(`${tag}: ${k} 없음 (원래 "${x[k]}")`);
    else if (x[k] !== y[k]) diffs.push(`${tag}: ${k} 값 다름 ("${x[k]}" → "${y[k]}")`);
  }
  for (const k of Object.keys(y)) {
    if (!Object.prototype.hasOwnProperty.call(x, k)) diffs.push(`${tag}: ${k} 가 새로 생김 ("${y[k]}")`);
  }
  return diffs;
}

// 쓰기 전에 메모리에서 "쓰고 → 읽은 것처럼 → 되돌리기"를 해보고 원본과 같은지 확인
function verifyRoundtrip(dataset) {
  const tabs = encodeDataset(dataset);
  const back = decodeDataset(simulateSheets(tabs));
  const diffs = compareDatasets(dataset, back.dataset);
  return { ok: diffs.length === 0, diffs, tabs };
}

module.exports = {
  MAXP, SLOTS, RANKS, LEVELS, SCHEMA_VERSION,
  TAB_HEADERS, DATA_TABS, BACKUP_TAB, BACKUP_HEADERS, REQUIRED,
  toCell, fromCell, classifyKey,
  encodeDataset, decodeDataset, simulateSheets, simulateRow,
  compareDatasets, compareStates, verifyRoundtrip,
};
