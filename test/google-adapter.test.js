'use strict';
// 실제 구글 연결 코드(sheets-google.js)가 Sheets API를 올바른 형식으로 부르는지,
// 가짜 API 객체(동작은 실제 API 규칙대로 흉내)로 확인합니다.
const test = require('node:test');
const assert = require('node:assert');
const { GoogleSheets } = require('../lib/sheets-google');
const { Store } = require('../lib/store');

function fakeSheetsApi() {
  const tabs = new Map([['latest', { sheetId: 11, rows: [['2026-10-04', JSON.stringify({ sessions: [{ label: 'X', state: { participantCount: '2', 'p-name-1': 'a' }, hidden: false }], currentSessionIndex: 0, roundCount: 3, roundLabels: ['1부', '2부', '3부'] })]], rowCount: 1000, colCount: 26 }]]);
  let nextId = 100;
  const calls = [];
  const parseRange = (r) => {
    const m = String(r).match(/^'((?:[^']|'')+)'(?:!A1)?$/);
    if (!m) throw new Error('잘못된 범위 형식: ' + r);
    return m[1].replace(/''/g, "'");
  };
  const api = {
    spreadsheets: {
      get: async (p) => {
        calls.push(['get', p]);
        assert.ok(p.fields.includes('gridProperties'));
        return { data: { properties: { title: '홀덤 장부' }, sheets: [...tabs].map(([title, t]) => ({ properties: { sheetId: t.sheetId, title, gridProperties: { rowCount: t.rowCount, columnCount: t.colCount } } })) } };
      },
      batchUpdate: async (p) => {
        calls.push(['batchUpdate', p]);
        for (const r of p.requestBody.requests) {
          if (r.addSheet) {
            assert.ok(r.addSheet.properties.title);
            tabs.set(r.addSheet.properties.title, { sheetId: nextId++, rows: [], rowCount: 1000, colCount: 26 });
          } else if (r.updateSheetProperties) {
            const t = [...tabs.values()].find((x) => x.sheetId === r.updateSheetProperties.properties.sheetId);
            const g = r.updateSheetProperties.properties.gridProperties;
            assert.strictEqual(r.updateSheetProperties.fields, 'gridProperties.rowCount,gridProperties.columnCount');
            t.rowCount = g.rowCount; t.colCount = g.columnCount;
          } else if (r.deleteDimension) {
            const t = [...tabs.values()].find((x) => x.sheetId === r.deleteDimension.range.sheetId);
            t.rows.splice(r.deleteDimension.range.startIndex, 1);
          } else if (r.repeatCell) { /* 서식 */ } else throw new Error('알 수 없는 요청 ' + JSON.stringify(r));
        }
        return { data: {} };
      },
      values: {
        batchGet: async (p) => {
          calls.push(['batchGet', p]);
          assert.strictEqual(p.valueRenderOption, 'UNFORMATTED_VALUE');
          return { data: { valueRanges: p.ranges.map((r) => {
            const rows = tabs.get(parseRange(r)).rows.map((row) => { const x = row.map((c) => (c === '' ? undefined : c)); while (x.length && x[x.length - 1] === undefined) x.pop(); return x; });
            while (rows.length && !rows[rows.length - 1].length) rows.pop();
            return rows.length ? { range: r, values: rows } : { range: r }; // 빈 탭은 values 없음 (실제 API와 동일)
          }) } };
        },
        batchUpdate: async (p) => {
          calls.push(['values.batchUpdate', p]);
          assert.strictEqual(p.requestBody.valueInputOption, 'RAW');
          for (const d of p.requestBody.data) {
            const t = tabs.get(parseRange(d.range.replace(/!A1$/, '')));
            assert.ok(d.values.length <= t.rowCount, `격자 행 부족 ${d.values.length} > ${t.rowCount}`);
            d.values.forEach((row, r) => {
              assert.ok(row.length <= t.colCount, `격자 열 부족 ${row.length} > ${t.colCount}`);
              assert.ok(row.every((c) => c !== null && c !== undefined), 'null/undefined 값은 "건너뛰기"라서 지우기에 쓰면 안 됨');
              if (!t.rows[r]) t.rows[r] = [];
              row.forEach((v, c) => { t.rows[r][c] = v; });
            });
          }
          return { data: {} };
        },
        append: async (p) => {
          calls.push(['append', p]);
          assert.strictEqual(p.valueInputOption, 'RAW');
          assert.strictEqual(p.insertDataOption, 'INSERT_ROWS');
          const t = tabs.get(parseRange(p.range.replace(/!A1$/, '')));
          assert.ok(p.requestBody.values[0].length <= t.colCount, '추가 행의 열이 격자보다 많음');
          const rows = t.rows.filter((r) => r && r.some((c) => c !== '' && c !== undefined));
          t.rows = rows.concat([p.requestBody.values[0]]);
          return { data: {} };
        },
      },
    },
  };
  return { api, tabs, calls };
}

test('구글 어댑터: 이전 → 저장 → 백업/삭제까지 올바른 API 형식', async () => {
  const fake = fakeSheetsApi();
  const g = new GoogleSheets({ spreadsheetId: 'SHEET', sheetsApi: fake.api });
  const store = new Store(g, { log: { error() {}, log() {} } });
  assert.strictEqual((await store.getData()).status, 'migration_pending');
  const r = await store.migrationApply();
  assert.strictEqual(r.ok, true);
  const d = (await store.getData()).dataset;
  assert.strictEqual(d.days[0].state['p-name-1'], 'a');
  // 저장
  const big = { ...d.days[0].state };
  for (let i = 0; i < 200; i++) big[`extra-${i}`] = 'y'.repeat(400); // 긴 백업 → 열 여러 개
  await store.save({ changes: [{ id: d.days[0].id, baseVersion: d.days[0].version, label: 'X2', hidden: false, state: big }] });
  assert.strictEqual((await store.getData()).dataset.days[0].label, 'X2');
  const { id } = await store.createBackup('긴 백업');
  const list = await store.listBackups();
  assert.ok(list.some((b) => b.id === id));
  await store.deleteBackup(id);
  assert.ok(!(await store.listBackups()).some((b) => b.id === id));
  // 기존 latest 탭에는 쓰기 요청이 한 번도 없어야 함
  const writes = fake.calls.filter(([k]) => k === 'values.batchUpdate' || k === 'append');
  assert.ok(writes.every(([, p]) => JSON.stringify(p).indexOf("'latest'") < 0), 'latest 탭에 쓰기 발생');
  // 모든 데이터 탭 쓰기는 한 번의 요청에 묶여야 함 (저장 1회 = values.batchUpdate 1회)
  const lastWrite = writes.filter(([k]) => k === 'values.batchUpdate').pop()[1];
  assert.ok(lastWrite.requestBody.data.length >= 9);
});

test('구글 어댑터: 탭 이름 따옴표 처리', async () => {
  const fake = fakeSheetsApi();
  fake.tabs.set("it's", { sheetId: 5, rows: [['a']], rowCount: 10, colCount: 5 });
  const g = new GoogleSheets({ spreadsheetId: 'SHEET', sheetsApi: fake.api });
  const r = await g.readTabs(["it's", '없는탭']);
  assert.deepStrictEqual(r["it's"], [['a']]);
  assert.strictEqual(r['없는탭'], null);
});
