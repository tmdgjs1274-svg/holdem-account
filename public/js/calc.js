/*
 * 정산(최종 처리금액) 계산 — 순수 함수 버전
 * 화면의 recalcAll()과 같은 순서·같은 규칙으로 계산합니다. 서버는 이 함수로 시트의 settlement 탭을 채우고,
 * 테스트에서 화면 계산 결과와 1원 단위까지 같은지 비교합니다.
 *
 * 화면(브라우저)이 값을 다루는 방식도 그대로 따라합니다:
 *  - 저장값에 key가 없으면 화면의 기본값을 씁니다(예: 예전 날짜에 없는 3부 → 기본값).
 *  - 바이인 콤보에 없는 금액은 화면에서 선택되지 않으므로 0으로 봅니다.
 *  - 숫자 칸에 숫자가 아닌 값은 화면에서 빈 칸이 되므로 0으로 봅니다.
 *  - 순위 결과의 참가자 번호가 참가자 수보다 크면 화면에서 선택되지 않으므로 무시합니다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAXP = 9;
  var REBUY_SLOTS = 4;
  var BUYIN_OPTIONS = ['0', '1000', '2000', '3000', '4000', '5000', '6000'];
  var DEFAULT_RANKS = [
    { label: '1등', ratio: 30, normalRatio: 60 },
    { label: '2등', ratio: 15, normalRatio: 30 },
    { label: '3등', ratio: 5, normalRatio: 10 },
    { label: '-', ratio: 0, normalRatio: 0 },
  ];
  var DEFAULT_BOUNTY_LEVELS = [
    [{ label: 'A상', ratio: 45, count: 1 }, { label: 'K상', ratio: 30, count: 2 }, { label: 'Q상', ratio: 25, count: 3 }, { label: '꽝', ratio: 0, count: 30 }],
    [{ label: 'A상', ratio: 60, count: 1 }, { label: 'K상', ratio: 30, count: 2 }, { label: 'Q상', ratio: 10, count: 4 }, { label: '꽝', ratio: 0, count: 11 }],
    [{ label: 'A상', ratio: 60, count: 1 }, { label: 'K상', ratio: 30, count: 2 }, { label: 'Q상', ratio: 10, count: 4 }, { label: '꽝', ratio: 0, count: 8 }],
  ];
  var NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/; // HTML number 입력칸이 받아들이는 형식

  function levelsFor(r) {
    return DEFAULT_BOUNTY_LEVELS[r - 1] || DEFAULT_BOUNTY_LEVELS[DEFAULT_BOUNTY_LEVELS.length - 1];
  }
  // 화면을 처음 만들었을 때의 기본값 (applyState가 빈 key에 채우는 값과 동일)
  function defaultValue(key) {
    var m;
    if (key === 'participantCount') return String(MAXP);
    if (key === 'bounty-ratio-input') return '50';
    if ((m = key.match(/^rank-label-(\d)$/))) return DEFAULT_RANKS[+m[1]].label;
    if ((m = key.match(/^rank-ratio-normal-(\d)$/))) return String(DEFAULT_RANKS[+m[1]].normalRatio);
    if ((m = key.match(/^rank-ratio-(\d)$/))) return String(DEFAULT_RANKS[+m[1]].ratio);
    if (/^gtype-/.test(key)) return 'bounty';
    if (/^buyin-/.test(key)) return '0';
    if (/^bg-/.test(key)) return '0';
    if ((m = key.match(/^bl-label-(\d+)-(\d)$/))) return levelsFor(+m[1])[+m[2]].label;
    if ((m = key.match(/^bl-ratio-(\d+)-(\d)$/))) return String(levelsFor(+m[1])[+m[2]].ratio);
    if ((m = key.match(/^bl-count-(\d+)-(\d)$/))) return String(levelsFor(+m[1])[+m[2]].count);
    return '';
  }
  function getter(state) {
    return function (key) {
      return Object.prototype.hasOwnProperty.call(state, key) ? String(state[key]) : defaultValue(key);
    };
  }
  function numInput(v) { return NUMBER_RE.test(v) ? parseFloat(v) : 0; }
  function buyinValue(v) { return BUYIN_OPTIONS.indexOf(String(v)) >= 0 ? parseFloat(v) : 0; }

  function computeSettlement(state, opts) {
    var get = getter(state || {});
    var roundCount = (opts && opts.roundCount) || 3;
    var roundLabels = (opts && opts.roundLabels) || [];
    var pc = get('participantCount');
    var n = /^[2-9]$/.test(pc) ? parseInt(pc, 10) : 0;
    var pname = function (i) {
      var v = get('p-name-' + i).replace(/[\r\n]/g, '').trim();
      return v ? v : ('참가자' + i);
    };

    var bountyRankRatios = [0, 1, 2, 3].map(function (r) { return numInput(get('rank-ratio-' + r)) / 100; });
    var bountyRatio = numInput(get('bounty-ratio-input')) / 100;
    var normalRankRatios = [0, 1, 2, 3].map(function (r) { return numInput(get('rank-ratio-normal-' + r)) / 100; });

    var finalBuyin = []; var i, round, rr, lv, s;
    for (i = 0; i <= MAXP; i++) finalBuyin.push(0);
    var finalPrize = [], finalBounty = [], rankPrizes = {}, roundTotals = {};
    for (round = 0; round <= roundCount; round++) { finalPrize.push({}); finalBounty.push({}); }
    for (i = 1; i <= MAXP; i++) for (round = 1; round <= roundCount; round++) { finalPrize[round][i] = 0; finalBounty[round][i] = 0; }

    for (round = 1; round <= roundCount; round++) {
      var roundTotal = 0;
      for (i = 1; i <= n; i++) {
        var sum = 0;
        for (s = 0; s <= REBUY_SLOTS; s++) sum += buyinValue(get('buyin-' + round + '-' + i + '-' + s));
        finalBuyin[i] += sum;
        roundTotal += sum;
      }
      roundTotals[round] = roundTotal;
      var gtype = get('gtype-' + round) === 'normal' ? 'normal' : 'bounty';
      var effRankRatios = gtype === 'normal' ? normalRankRatios : bountyRankRatios;
      var effBountyRatio = gtype === 'normal' ? 0 : bountyRatio;

      rankPrizes[round] = [];
      for (rr = 0; rr < 4; rr++) {
        var amount = roundTotal * effRankRatios[rr];
        rankPrizes[round].push(amount);
        var w = get('rankwin-' + round + '-' + rr);
        var wi = parseInt(w, 10);
        if (w && String(wi) === w && wi >= 1 && wi <= n) finalPrize[round][wi] = (finalPrize[round][wi] || 0) + amount;
      }
      var bountyPool = roundTotal * effBountyRatio;
      var levelRatios = [];
      for (lv = 0; lv < 4; lv++) levelRatios.push(numInput(get('bl-ratio-' + round + '-' + lv)) / 100);
      for (i = 1; i <= n; i++) {
        var pBounty = 0;
        for (lv = 0; lv < 4; lv++) {
          var cnt = numInput(get('bg-' + round + '-' + lv + '-' + i));
          pBounty += cnt * levelRatios[lv] * bountyPool;
        }
        finalBounty[round][i] = pBounty;
      }
    }

    var players = []; var grandCheck = 0;
    for (i = 1; i <= MAXP; i++) {
      var buyinVal = -finalBuyin[i];
      var totalFinal = buyinVal;
      var rounds = [];
      for (round = 1; round <= roundCount; round++) {
        var pv = finalPrize[round][i] || 0;
        var bv = finalBounty[round][i] || 0;
        rounds.push({ prize: Math.round(pv), bounty: Math.round(bv) });
        totalFinal += pv + bv;
      }
      if (i <= n) {
        grandCheck += totalFinal;
        players.push({ slot: i, name: pname(i), buyin: Math.round(buyinVal), rounds: rounds, total: Math.round(totalFinal) });
      }
    }
    return {
      n: n,
      roundCount: roundCount,
      roundLabels: roundLabels,
      players: players,
      rankPrizes: rankPrizes,
      roundTotals: roundTotals,
      grandCheck: Math.round(grandCheck),
    };
  }

  return {
    MAXP: MAXP,
    BUYIN_OPTIONS: BUYIN_OPTIONS,
    DEFAULT_RANKS: DEFAULT_RANKS,
    DEFAULT_BOUNTY_LEVELS: DEFAULT_BOUNTY_LEVELS,
    defaultValue: defaultValue,
    buyinValue: buyinValue,
    computeSettlement: computeSettlement,
  };
});
