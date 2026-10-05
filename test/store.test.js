'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../lib/store');
const { MemorySheets } = require('../lib/sheets-memory');
const schema = require('../lib/schema');

const quiet = { error() {}, log() {} };
function legacyFixture() {
  const st = (n, names) => {
    const s = { participantCount: String(n), 'bounty-ratio-input': '50', 'gtype-1': 'bounty' };
    for (let i = 1; i <= 9; i++) s[`p-name-${i}`] = names[i - 1] || '';
    for (let i = 1; i <= 9; i++) for (let k = 0; k < 5; k++) s[`buyin-1-${i}-${k}`] = i <= n && k < 2 ? '3000' : '0';
    s['rankwin-1-0'] = '1'; s['rankwin-1-1'] = '2';
    return s;
  };
  return { sessions: [
    { label: '테스트 1회', state: st(4, ['가', '나', '다', '라']), hidden: false },
    { label: '테스트 2회', state: st(3, ['가', '나', '마']), hidden: true },
  ], currentSessionIndex: 0, roundCount: 3, roundLabels: ['1부', '2부', '3부'] };
}
function seeded() {
  const raw = JSON.stringify(legacyFixture());
  return { mem: new MemorySheets({ seed: { latest: [['2026-10-04T10:00:00.000Z', raw]], history: [['x', 'y']] } }), raw };
}

test('이전 전: migration_pending, 저장 거절', async () => {
  const { mem } = seeded();
  const store = new Store(mem, { log: quiet });
  const d = await store.getData();
  assert.strictEqual(d.status, 'migration_pending');
  await assert.rejects(store.save({ changes: [{ id: 'dnew00001', baseVersion: 0, label: 'x', hidden: false, state: {} }] }), (e) => e.code === 'MIGRATION_PENDING');
});

test('이전: 원본 그대로 + latest 탭은 변경 없음 + 두 번째 이전은 거절', async () => {
  const { mem, raw } = seeded();
  const before = JSON.stringify(mem.tabs.get('latest'));
  const store = new Store(mem, { log: quiet });
  const p = await store.migrationPreview();
  assert.strictEqual(p.ok, true);
  const r = await store.migrationApply();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(JSON.stringify(mem.tabs.get('latest')), before);
  const d = await store.getData();
  assert.strictEqual(d.status, 'ok');
  const orig = JSON.parse(raw);
  d.dataset.days.forEach((day, i) => {
    assert.deepStrictEqual(day.state, orig.sessions[i].state);
    assert.strictEqual(day.label, orig.sessions[i].label);
    assert.strictEqual(day.hidden, !!orig.sessions[i].hidden);
  });
  const backups = await store.listBackups();
  assert.strictEqual(backups[0].kind, 'migration-source');
  await assert.rejects(store.migrationApply(), (e) => e.code === 'ALREADY_MIGRATED');
});

async function migrated() {
  const { mem } = seeded();
  const store = new Store(mem, { log: quiet });
  await store.migrationApply();
  return { mem, store };
}

test('버전 충돌: 오래된 버전으로 저장하면 거절, 데이터는 그대로', async () => {
  const { store } = await migrated();
  const d = (await store.getData()).dataset;
  const day = d.days[0];
  const a = await store.save({ changes: [{ id: day.id, baseVersion: day.version, label: day.label, hidden: false, state: { ...day.state, 'p-name-1': 'A기기' } }] });
  assert.strictEqual(a.versions[day.id], day.version + 1);
  await assert.rejects(
    store.save({ changes: [{ id: day.id, baseVersion: day.version, label: day.label, hidden: false, state: { ...day.state, 'p-name-1': 'B기기' } }] }),
    (e) => e.code === 'CONFLICT' && e.conflicts[0].id === day.id,
  );
  const after = (await store.getData()).dataset.days[0];
  assert.strictEqual(after.state['p-name-1'], 'A기기');
});

test('일부 날짜만 보낸 저장은 다른 날짜를 지우지 않음 (삭제는 명시적으로만)', async () => {
  const { store } = await migrated();
  const d = (await store.getData()).dataset;
  await store.save({ changes: [{ id: 'dnewday001', baseVersion: 0, label: '새 날짜', hidden: false, state: { participantCount: '2' } }], order: ['dnewday001'] });
  const d2 = (await store.getData()).dataset;
  assert.strictEqual(d2.days.length, 3);
  assert.deepStrictEqual(d2.days.map((x) => x.id).sort(), [...d.days.map((x) => x.id), 'dnewday001'].sort());
  assert.strictEqual(d2.days[0].id, 'dnewday001');
  // 명시적 삭제 + 자동 백업
  await store.save({ deletes: [{ id: 'dnewday001', baseVersion: 1 }] });
  const d3 = (await store.getData()).dataset;
  assert.strictEqual(d3.days.length, 2);
  const kinds = (await store.listBackups()).map((b) => b.kind);
  assert.ok(kinds.includes('auto-before-delete'));
});

test('모든 날짜 삭제는 거절', async () => {
  const { store } = await migrated();
  const d = (await store.getData()).dataset;
  await assert.rejects(store.save({ deletes: d.days.map((x) => ({ id: x.id, baseVersion: x.version })) }), (e) => e.code === 'INVALID');
});

test('쓰기 실패 시 시트 데이터는 그대로 (반쪽 저장 없음)', async () => {
  const { mem, store } = await migrated();
  const before = JSON.stringify([...mem.tabs.entries()].filter(([t]) => schema.DATA_TABS.includes(t)));
  const d = (await store.getData()).dataset;
  mem.failNext('write');
  await assert.rejects(store.save({ changes: [{ id: d.days[0].id, baseVersion: d.days[0].version, label: 'x', hidden: false, state: {} }] }));
  const after = JSON.stringify([...mem.tabs.entries()].filter(([t]) => schema.DATA_TABS.includes(t)));
  assert.strictEqual(after, before);
});

test('날짜가 줄어들면 남는 예전 행이 깨끗이 지워짐', async () => {
  const { mem, store } = await migrated();
  const d = (await store.getData()).dataset;
  await store.save({ deletes: [{ id: d.days[1].id, baseVersion: d.days[1].version }] });
  const raw = MemorySheets.normalize(mem.tabs.get('buyins'));
  assert.ok(raw.slice(1).every((r) => r[0] === d.days[0].id), '삭제된 날짜의 행이 남아있음');
});

test('백업 복원: 복원 전 자동 백업 + 데이터 원복', async () => {
  const { store } = await migrated();
  const d = (await store.getData()).dataset;
  const { id } = await store.createBackup('복원 테스트');
  await store.save({ changes: [{ id: d.days[0].id, baseVersion: d.days[0].version, label: '바뀐 이름', hidden: false, state: { ...d.days[0].state, 'p-name-1': 'ZZ' } }] });
  await store.restoreBackup(id);
  const r = (await store.getData()).dataset;
  assert.strictEqual(r.days[0].label, d.days[0].label);
  assert.deepStrictEqual(r.days[0].state, d.days[0].state);
  assert.ok(r.days[0].version > d.days[0].version + 1, '복원 후 버전이 올라가야 다른 기기의 오래된 저장을 막음');
  assert.ok((await store.listBackups()).some((b) => b.kind === 'auto-before-restore'));
});

test('긴 데이터 백업은 여러 칸에 나눠 저장되고 그대로 복원됨', async () => {
  const { store } = await migrated();
  const d = (await store.getData()).dataset;
  const big = { ...d.days[0].state };
  for (let i = 0; i < 300; i++) big[`extra-${i}`] = 'x'.repeat(300);
  await store.save({ changes: [{ id: d.days[0].id, baseVersion: d.days[0].version, label: d.days[0].label, hidden: false, state: big }] });
  const { id } = await store.createBackup('큰 백업');
  const list = await store.listBackups();
  assert.ok(list.find((b) => b.id === id).size > 40000);
  await store.restoreBackup(id);
  assert.deepStrictEqual((await store.getData()).dataset.days[0].state, big);
});
