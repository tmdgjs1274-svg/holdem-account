'use strict';
const test = require('node:test');
const assert = require('node:assert');
const schema = require('../lib/schema');
const legacy = require('../lib/legacy');

// 결정적 난수 (재현 가능한 테스트)
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const WEIRD = ['', '0', '3000', '2000', '0050', '1e3', '-0', '-5', '2.5', '.5', '=SUM(A1)', "'따옴표", '공백 있음 ', ' 앞공백', '줄\n바꿈', '쉼표,값', '"큰따옴표"', 'TRUE', 'NaN', 'Infinity', '9007199254740993', '바운티', 'bounty', 'normal', '일반', '🃏', '-', 'A상'];

function randomState(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const st = {};
  const maybe = (k, v) => { if (r() > 0.08) st[k] = v; };
  maybe('participantCount', pick(['2', '5', '9', '4', '', '12']));
  maybe('bounty-ratio-input', pick(WEIRD));
  for (let i = 1; i <= 9; i++) maybe(`p-name-${i}`, pick(['홍길동', '김철수', '', 'Kim, J', '1004', ...WEIRD]));
  for (let k = 0; k < 4; k++) { maybe(`rank-label-${k}`, pick(WEIRD)); maybe(`rank-ratio-normal-${k}`, pick(WEIRD)); maybe(`rank-ratio-${k}`, pick(WEIRD)); }
  const rounds = 1 + Math.floor(r() * 5);
  for (let rr = 1; rr <= rounds; rr++) {
    maybe(`gtype-${rr}`, pick(['bounty', 'normal', '', '바운티', 'x']));
    for (let i = 1; i <= 9; i++) for (let s = 0; s < 5; s++) maybe(`buyin-${rr}-${i}-${s}`, pick(['0', '2000', '3000', '', '2500', ...WEIRD]));
    for (let k = 0; k < 4; k++) maybe(`rankwin-${rr}-${k}`, pick(['', '1', '3', '9', '10', '01']));
    for (let lv = 0; lv < 4; lv++) {
      maybe(`bl-label-${rr}-${lv}`, pick(WEIRD)); maybe(`bl-ratio-${rr}-${lv}`, pick(WEIRD)); maybe(`bl-count-${rr}-${lv}`, pick(WEIRD));
      for (let i = 1; i <= 9; i++) maybe(`bg-${rr}-${lv}-${i}`, pick(WEIRD));
    }
  }
  if (r() > 0.7) st['unknown-field'] = pick(WEIRD);
  if (r() > 0.8) st['p-name-12'] = '범위밖';
  return st;
}

test('무작위 데이터 300개 날짜: 시트에 썼다 읽어도 1글자도 다르지 않음', () => {
  const r = rng(42);
  for (let t = 0; t < 30; t++) {
    const days = [];
    for (let d = 0; d < 10; d++) days.push({ id: 'dtest' + t + 'x' + d, label: `${t}-${d} 날짜, "테스트"`, hidden: r() > 0.7, version: Math.floor(r() * 9), updatedAt: '2026-10-05T00:00:00.000Z', state: randomState(r) });
    const ds = { days, roundCount: 5, roundLabels: ['1부', '2부', '3부', '4부', '5부'], currentDayId: days[3].id, extraMeta: { foo: 'bar' } };
    const v = schema.verifyRoundtrip(ds);
    assert.deepStrictEqual(v.diffs, [], `라운드트립 차이 (t=${t})`);
  }
});

test('예전 JSON → 새 구조 → 비교: 차이 0', () => {
  const r = rng(7);
  const obj = { sessions: Array.from({ length: 6 }, (_, i) => ({ label: `날짜${i}`, state: randomState(r), hidden: i === 2 })), currentSessionIndex: 4, roundCount: 3, roundLabels: ['1부', '2부', '3부'] };
  const ds = legacy.legacyToDataset(JSON.parse(JSON.stringify(obj)));
  const v = schema.verifyRoundtrip(ds);
  const back = schema.decodeDataset(schema.simulateSheets(v.tabs)).dataset;
  const cmp = legacy.compareLegacyWithDataset(obj, back);
  assert.deepStrictEqual(cmp.diffs, []);
});

test('시트에서 열 순서를 바꿔도 머리글로 찾아서 읽음', () => {
  const r = rng(3);
  const ds = { days: [{ id: 'dabcdef1', label: 'A', hidden: false, version: 1, updatedAt: 'x', state: randomState(r) }], roundCount: 5, roundLabels: ['1부', '2부', '3부', '4부', '5부'], currentDayId: 'dabcdef1', extraMeta: {} };
  const tabs = schema.simulateSheets(schema.encodeDataset(ds));
  // buyins 탭의 열 순서를 거꾸로
  tabs.buyins = tabs.buyins.map((row) => { const w = tabs.buyins[0].length; const full = Array.from({ length: w }, (_, i) => row[i]); return full.reverse(); });
  const back = schema.decodeDataset(tabs).dataset;
  assert.deepStrictEqual(schema.compareDatasets(ds, back), []);
});

test('필요한 머리글이 사라지면 추측하지 않고 오류', () => {
  const ds = { days: [{ id: 'dabcdef1', label: 'A', hidden: false, version: 1, updatedAt: 'x', state: { 'buyin-1-1-0': '3000' } }], roundCount: 3, roundLabels: ['1부', '2부', '3부'], currentDayId: 'dabcdef1', extraMeta: {} };
  const tabs = schema.simulateSheets(schema.encodeDataset(ds));
  tabs.buyins[0][5] = '바이인(수정됨)';
  assert.throws(() => schema.decodeDataset(tabs), (e) => e.code === 'SCHEMA_HEADER_MISSING');
});

test('숫자로 저장하는 값은 정확히 같은 글자로 되돌아오는 경우뿐', () => {
  assert.strictEqual(schema.toCell('3000'), 3000);
  assert.strictEqual(schema.toCell('0050'), '0050');
  assert.strictEqual(schema.toCell('1e3'), '1e3');
  assert.strictEqual(schema.toCell('-0'), '-0');
  assert.strictEqual(schema.toCell('Infinity'), 'Infinity');
  assert.strictEqual(schema.toCell('NaN'), 'NaN');
  assert.strictEqual(schema.toCell('9007199254740993'), '9007199254740993');
});
