'use strict';
/*
 * 실제 구글 시트 연결 (서비스 계정 + Google Sheets API v4)
 *  - 읽기: UNFORMATTED_VALUE (시트에서 표시형식을 바꿔도 "3,000" 같은 글자가 아니라 원래 숫자로 읽힘)
 *  - 쓰기: RAW (입력값을 수식·날짜로 해석하지 않고 그대로 저장)
 *  - 한 번의 저장에 들어가는 모든 탭은 하나의 요청(values.batchUpdate)으로 씁니다.
 *  - 429/5xx 오류는 잠시 후 자동 재시도합니다.
 */
const { google } = require('googleapis');

function loadCredentials() {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!raw && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    raw = require('fs').readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
  }
  raw = raw.trim();
  if (!raw) return null;
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8'); // base64로 넣은 경우
  const cred = JSON.parse(raw);
  if (cred.private_key) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return cred;
}

const q = (title) => `'${String(title).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GoogleSheets {
  constructor({ spreadsheetId, credentials, sheetsApi }) {
    if (!spreadsheetId) throw new Error('SPREADSHEET_ID가 설정되지 않았습니다.');
    this.spreadsheetId = spreadsheetId;
    if (sheetsApi) this.api = sheetsApi; // 테스트용 주입
    else {
      if (!credentials) throw new Error('서비스 계정 키(GOOGLE_SERVICE_ACCOUNT_JSON)가 설정되지 않았습니다.');
      const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      this.api = google.sheets({ version: 'v4', auth });
    }
    this.serviceAccountEmail = credentials && credentials.client_email;
    this._meta = null;
  }

  async _call(fn) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const status = e.code || (e.response && e.response.status);
        if (![429, 500, 502, 503, 504].includes(Number(status))) throw e;
        await sleep(800 * Math.pow(2, attempt));
      }
    }
    throw lastErr;
  }

  async _loadMeta(force) {
    if (this._meta && !force) return this._meta;
    const res = await this._call(() => this.api.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
    }));
    const tabs = {};
    for (const s of res.data.sheets || []) {
      const p = s.properties;
      tabs[p.title] = { sheetId: p.sheetId, rowCount: p.gridProperties.rowCount, colCount: p.gridProperties.columnCount };
    }
    this._meta = { title: res.data.properties.title, tabs };
    return this._meta;
  }

  async describe() {
    const m = await this._loadMeta(true);
    return { title: m.title, tabs: Object.keys(m.tabs).map((t) => ({ title: t })), serviceAccountEmail: this.serviceAccountEmail };
  }

  async readTabs(titles) {
    const m = await this._loadMeta(true);
    const existing = titles.filter((t) => m.tabs[t]);
    const out = {};
    for (const t of titles) out[t] = null;
    if (!existing.length) return out;
    const res = await this._call(() => this.api.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges: existing.map(q),
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    }));
    (res.data.valueRanges || []).forEach((vr, i) => { out[existing[i]] = vr.values || []; });
    return out;
  }

  async ensureTabs(titles) {
    const m = await this._loadMeta(true);
    const missing = titles.filter((t) => !m.tabs[t]);
    if (!missing.length) return;
    await this._call(() => this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) },
    }));
    const m2 = await this._loadMeta(true);
    // 머리글 굵게
    await this._call(() => this.api.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: missing.filter((t) => m2.tabs[t]).map((t) => ({
          repeatCell: {
            range: { sheetId: m2.tabs[t].sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        })),
      },
    }));
  }

  // 쓰기 전에 시트 격자(행/열 수)가 충분한지 확인하고 모자라면 늘립니다.
  async _ensureGrid(sizes) {
    const m = await this._loadMeta(true);
    const requests = [];
    for (const [title, { rows, cols }] of Object.entries(sizes)) {
      const t = m.tabs[title];
      if (!t) continue;
      const needRows = Math.max(t.rowCount, rows + 50);
      const needCols = Math.max(t.colCount, cols);
      if (needRows > t.rowCount || needCols > t.colCount) {
        requests.push({
          updateSheetProperties: {
            properties: { sheetId: t.sheetId, gridProperties: { rowCount: needRows, columnCount: needCols } },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        });
      }
    }
    if (requests.length) {
      await this._call(() => this.api.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } }));
    }
  }

  // map: { title: rows } — 이미 패딩된 행(빈 문자열 = 지우기). 하나의 요청으로 모든 탭을 씁니다.
  async writeTabs(map) {
    const sizes = {};
    for (const [t, rows] of Object.entries(map)) sizes[t] = { rows: rows.length, cols: Math.max(1, ...rows.map((r) => r.length)) };
    await this._ensureGrid(sizes);
    await this._call(() => this.api.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: Object.entries(map).map(([t, rows]) => ({ range: `${q(t)}!A1`, majorDimension: 'ROWS', values: rows })),
      },
    }));
  }

  async appendRow(title, row) {
    await this._ensureGrid({ [title]: { rows: 1, cols: row.length } });
    await this._call(() => this.api.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${q(title)}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { majorDimension: 'ROWS', values: [row] },
    }));
  }

  // colIndex 열의 값이 value인 행을 지웁니다(머리글 제외).
  async deleteRowsWhere(title, colIndex, value) {
    const m = await this._loadMeta(true);
    const t = m.tabs[title];
    if (!t) return 0;
    const data = await this.readTabs([title]);
    const rows = data[title] || [];
    const idxs = [];
    rows.forEach((r, i) => { if (i > 0 && r && String(r[colIndex]) === String(value)) idxs.push(i); });
    if (!idxs.length) return 0;
    const requests = idxs.sort((a, b) => b - a).map((i) => ({
      deleteDimension: { range: { sheetId: t.sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } },
    }));
    await this._call(() => this.api.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } }));
    return idxs.length;
  }
}

module.exports = { GoogleSheets, loadCredentials };
