'use strict';
/*
 * 테스트/로컬 개발용 "가짜 구글 시트". 실제 Sheets API와 같은 방식으로 동작합니다.
 *  - 빈 문자열을 쓰면 그 칸은 비워집니다. (쓰지 않은 칸은 예전 값이 그대로 남습니다 → 덜 지운 버그를 잡아냄)
 *  - 읽을 때 각 행 끝의 빈 칸, 표 끝의 빈 행은 잘려서 돌아옵니다.
 *  - 숫자는 숫자로, 문자열은 문자열로 돌려줍니다.
 */
const fs = require('fs');

class MemorySheets {
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.tabs = new Map();
    this.failures = []; // 테스트용 장애 주입: { op, count }
    this.calls = [];
    if (opts.seed) this._load(opts.seed);
    else if (this.file && fs.existsSync(this.file)) this._load(JSON.parse(fs.readFileSync(this.file, 'utf8')));
  }
  _load(obj) {
    for (const [t, rows] of Object.entries(obj)) this.tabs.set(t, rows.map((r) => r.slice()));
  }
  _persist() {
    if (!this.file) return;
    const obj = {};
    for (const [t, rows] of this.tabs) obj[t] = rows;
    fs.writeFileSync(this.file, JSON.stringify(obj));
  }
  _maybeFail(op) {
    this.calls.push(op);
    const f = this.failures.find((x) => x.op === op || x.op === '*');
    if (f && f.count > 0) {
      f.count--;
      const e = new Error(`(테스트) ${op} 실패`);
      e.code = 503;
      throw e;
    }
  }
  failNext(op, count = 1) { this.failures.push({ op, count }); }

  static normalize(rows) {
    const out = (rows || []).map((row) => {
      const r = row.map((c) => (c === '' || c === undefined || c === null ? undefined : c));
      while (r.length && r[r.length - 1] === undefined) r.pop();
      return r;
    });
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return out;
  }

  async describe() {
    this._maybeFail('describe');
    return { title: '(메모리 테스트 시트)', tabs: [...this.tabs.keys()].map((t) => ({ title: t })) };
  }
  async readTabs(titles) {
    this._maybeFail('read');
    const out = {};
    for (const t of titles) out[t] = this.tabs.has(t) ? MemorySheets.normalize(this.tabs.get(t)) : null;
    return JSON.parse(JSON.stringify(out));
  }
  async ensureTabs(titles) {
    this._maybeFail('ensureTabs');
    for (const t of titles) if (!this.tabs.has(t)) this.tabs.set(t, []);
    this._persist();
  }
  // map: { title: rows } — A1부터 덮어씀. 각 행은 이미 패딩되어 있다고 가정(빈 문자열 = 지우기)
  async writeTabs(map) {
    this._maybeFail('write');
    for (const [t, rows] of Object.entries(map)) {
      if (!this.tabs.has(t)) this.tabs.set(t, []);
      const grid = this.tabs.get(t);
      rows.forEach((row, r) => {
        if (!grid[r]) grid[r] = [];
        row.forEach((v, c) => { grid[r][c] = v === '' ? undefined : v; });
      });
    }
    this._persist();
  }
  async appendRow(title, row) {
    this._maybeFail('append');
    if (!this.tabs.has(title)) this.tabs.set(title, []);
    const grid = this.tabs.get(title);
    const norm = MemorySheets.normalize(grid);
    grid.length = norm.length;
    grid.push(row.map((v) => (v === '' ? undefined : v)));
    this._persist();
  }
  async deleteRowsWhere(title, colIndex, value) {
    this._maybeFail('delete');
    const grid = this.tabs.get(title);
    if (!grid) return 0;
    let removed = 0;
    for (let r = grid.length - 1; r >= 1; r--) {
      if (grid[r] && String(grid[r][colIndex]) === String(value)) { grid.splice(r, 1); removed++; }
    }
    this._persist();
    return removed;
  }
}

module.exports = { MemorySheets };
