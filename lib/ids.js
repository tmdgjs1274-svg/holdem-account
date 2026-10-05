'use strict';
const crypto = require('crypto');

// 날짜 ID: d + 시간(36진수) + 무작위 6자리 — 여러 기기에서 동시에 만들어도 겹치지 않습니다.
function newDayId() {
  return 'd' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 6);
}
function newBackupId() {
  return 'b' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 6);
}
const DAY_ID_RE = /^d[a-z0-9]{6,40}$/;

module.exports = { newDayId, newBackupId, DAY_ID_RE };
