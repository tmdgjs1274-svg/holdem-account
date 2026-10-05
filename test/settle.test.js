'use strict';
const test = require('node:test');
const assert = require('node:assert');
const calc = require('../public/js/calc.js');
const { Store } = require('../lib/store');
const { MemorySheets } = require('../lib/sheets-memory');

const quiet = { error() {}, log() {} };
// 참가자 n명, 1부 바운티 없이 일반게임: 각자 3000 바이인, 1등 winner가 전부 가져가는 단순한 날짜
function dayState(names, winnerSlot) {
  const s = { participantCount: String(names.length), 'gtype-1': 'normal', 'rank-ratio-normal-0': '100', 'rank-ratio-normal-1': '0', 'rank-ratio-normal-2': '0', 'rank-ratio-normal-3': '0' };
  for (let i = 1; i <= 9; i++) s[`p-name-${i}`] = names[i - 1] || '';
  for (let i = 1; i <= names.length; i++) s[`buyin-1-${i}-0`] = '3000';
  s['rankwin-1-0'] = String(winnerSlot);
  return s;
}

test('같은 이름끼리 각 날짜 최종 처리금액을 더함', () => {
  const days = [
    { id: 'd1', label: '1회', state: dayState(['홍길동', '김철수', '이영희'], 1) }, // 홍길동 +6000, 나머지 -3000
    { id: 'd2', label: '2회', state: dayState(['김철수', '홍길동'], 1) },          // 김철수 +3000, 홍길동 -3000
  ];
  const agg = calc.aggregateSettlement(days, { roundCount: 3 });
  const t = Object.fromEntries(agg.totals.map((x) => [x.name, x]));
  assert.strictEqual(t['홍길동'].total, 3000);
  assert.strictEqual(t['홍길동'].days, 2);
  assert.strictEqual(t['김철수'].total, 0);
  assert.strictEqual(t['이영희'].total, -3000);
  assert.strictEqual(agg.checkSum, 0);
  assert.strictEqual(agg.blocking, false);
  assert.deepStrictEqual(agg.totals.map((x) => x.name), ['홍길동', '김철수', '이영희']); // 합계 큰 순
});

test('이름 비어있음/같은 날 중복 이름은 막고, 앞뒤 공백은 같은 이름으로 봄', () => {
  const empty = calc.aggregateSettlement([{ id: 'd1', label: '1회', state: dayState(['홍길동', ''], 1) }], { roundCount: 3 });
  assert.strictEqual(empty.blocking, true);
  assert.strictEqual(empty.issues.emptyNames[0].slot, 2);
  const dup = calc.aggregateSettlement([{ id: 'd1', label: '1회', state: dayState(['홍길동', '홍길동'], 1) }], { roundCount: 3 });
  assert.strictEqual(dup.blocking, true);
  const sp = calc.aggregateSettlement([
    { id: 'd1', label: '1회', state: dayState([' 홍길동 ', '김철수'], 1) },
    { id: 'd2', label: '2회', state: dayState(['홍길동', '김철수'], 1) },
  ], { roundCount: 3 });
  assert.strictEqual(sp.totals.find((x) => x.name === '홍길동').days, 2);
});

async function setup() {
  const legacy = { sessions: [
    { label: '1회', state: dayState(['홍길동', '김철수', '이영희'], 1), hidden: false },
    { label: '2회', state: dayState(['김철수', '홍길동'], 1), hidden: false },
    { label: '3회', state: dayState(['이영희', '김철수'], 2), hidden: false },
  ], currentSessionIndex: 0, roundCount: 3, roundLabels: ['1부', '2부', '3부'] };
  const mem = new MemorySheets({ seed: { latest: [['t', JSON.stringify(legacy)]] } });
  const store = new Store(mem, { log: quiet });
  await store.migrationApply();
  const d = (await store.getData()).dataset;
  return { mem, store, d };
}

test('정산 저장 → 이력/탭 기록, 같은 날짜 이중 정산은 거절, 취소하면 다시 정산 가능', async () => {
  const { mem, store, d } = await setup();
  const ids = [d.days[0].id, d.days[1].id];
  const r = await store.createSettlement({ name: '1~2회 정산', dayIds: ids, expected: { '홍길동': 3000, '김철수': 0, '이영희': -3000 } });
  assert.strictEqual(r.run.status, '완료');
  assert.deepStrictEqual(r.run.dayIds, ids);
  const data = await store.getData();
  assert.strictEqual(data.settlements.length, 1);
  assert.strictEqual(data.settlements[0].totals.find((x) => x.name === '홍길동').total, 3000);
  assert.ok(mem.tabs.has('settle_runs') && mem.tabs.has('settle_totals') && mem.tabs.has('settle_details'));
  assert.strictEqual(MemorySheets.normalize(mem.tabs.get('settle_details')).length - 1, 5); // 3명 + 2명
  await assert.rejects(store.createSettlement({ name: '중복', dayIds: [d.days[1].id, d.days[2].id] }), (e) => e.code === 'ALREADY_SETTLED');
  await store.cancelSettlement(r.run.id);
  const r2 = await store.createSettlement({ name: '2~3회', dayIds: [d.days[1].id, d.days[2].id] });
  assert.strictEqual(r2.run.status, '완료');
  const all = (await store.getData()).settlements;
  assert.deepStrictEqual(all.map((x) => x.status), ['취소', '완료']);
});

test('화면에서 본 금액과 서버 금액이 다르면 저장하지 않음', async () => {
  const { store, d } = await setup();
  await assert.rejects(
    store.createSettlement({ name: 'x', dayIds: [d.days[0].id], expected: { '홍길동': 999 } }),
    (e) => e.code === 'CHANGED',
  );
  assert.strictEqual((await store.getData()).settlements.length, 0);
});

test('정산 뒤 날짜를 고쳐도 이력 금액은 그대로', async () => {
  const { store, d } = await setup();
  await store.createSettlement({ name: '1회', dayIds: [d.days[0].id] });
  const day = d.days[0];
  await store.save({ changes: [{ id: day.id, baseVersion: day.version, label: day.label, hidden: false, state: { ...day.state, 'rankwin-1-0': '2' } }] });
  const run = (await store.getData()).settlements[0];
  assert.strictEqual(run.totals.find((x) => x.name === '홍길동').total, 6000);
});
