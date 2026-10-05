/*
 * 홀덤 장부 — 화면 스크립트
 * 계산·화면 동작은 기존 HTML 버전과 동일합니다. 저장/불러오기만 서버(구글 시트) API로 바뀌었습니다.
 */
'use strict';
const MAXP = 9;
const REBUY_SLOTS = 4; // 바이인(최초) 포함 총 5칸
const ROUND_LABELS = ['1부','2부','3부'];
const DEFAULT_BUYIN_OPTIONS = [0,1000,2000,3000,4000,5000,6000];
const DEFAULT_RANKS = [
  {label:'1등', ratio:30, normalRatio:60},
  {label:'2등', ratio:15, normalRatio:30},
  {label:'3등', ratio:5, normalRatio:10},
  {label:'-', ratio:0, normalRatio:0},
];
const DEFAULT_BOUNTY_LEVELS = [
  [ {label:'A상',ratio:45,count:1}, {label:'K상',ratio:30,count:2}, {label:'Q상',ratio:25,count:3}, {label:'꽝',ratio:0,count:30} ],
  [ {label:'A상',ratio:60,count:1}, {label:'K상',ratio:30,count:2}, {label:'Q상',ratio:10,count:4}, {label:'꽝',ratio:0,count:11} ],
  [ {label:'A상',ratio:60,count:1}, {label:'K상',ratio:30,count:2}, {label:'Q상',ratio:10,count:4}, {label:'꽝',ratio:0,count:8} ],
];

function el(tag, attrs, html){
  const e = document.createElement(tag);
  if(attrs) for(const k in attrs) e.setAttribute(k, attrs[k]);
  if(html !== undefined) e.innerHTML = html;
  return e;
}
function fmt(n){
  if(n===null || n===undefined || isNaN(n)) return '0';
  return Math.round(n).toLocaleString('ko-KR');
}
function pname(i){
  const inp = document.getElementById('p-name-'+i);
  const v = inp && inp.value.trim();
  return v ? v : ('참가자'+i);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------- Toast notifications (top-right) ---------- */
function showToast(msg, isError){
  const container = document.getElementById('toastContainer');
  if(!container) return;
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(()=>{
    t.style.opacity = '0';
    setTimeout(()=> t.remove(), 300);
  }, 3800);
}

/* ---------- 1. Participants ---------- */
function buildParticipantCountSelect(){
  const sel = document.getElementById('participantCount');
  for(let n=2;n<=MAXP;n++){
    const o = el('option',{value:n}, n+'명');
    if(n===MAXP) o.selected = true;
    sel.appendChild(o);
  }
}
function buildParticipantTable(){
  const t = document.getElementById('participantTable');
  let html = '<tr><th style="width:60px;">번호</th><th>이름</th></tr>';
  for(let i=1;i<=MAXP;i++){
    html += `<tr class="prow-${i}"><td class="rowlabel">${i}</td>
      <td><input type="text" class="name-input" id="p-name-${i}" placeholder="참가자 ${i} 이름" data-role="pname" data-i="${i}"></td></tr>`;
  }
  t.innerHTML = html;
}

/* ---------- 2. Ratios ---------- */
function buildRankRatioTable(){
  const t = document.getElementById('rankRatioTable');
  let html = '<tr><th>등수</th><th>일반게임 비율(%)</th><th>바운티게임 비율(%)</th></tr>';
  DEFAULT_RANKS.forEach((r,idx)=>{
    html += `<tr><td><input type="text" id="rank-label-${idx}" value="${r.label}" style="width:70px;"></td>
      <td><input type="number" id="rank-ratio-normal-${idx}" value="${r.normalRatio}" data-role="rankratio" style="width:70px;"></td>
      <td><input type="number" id="rank-ratio-${idx}" value="${r.ratio}" data-role="rankratio" style="width:70px;"></td></tr>`;
  });
  html += `<tr><td class="rowlabel">바운티 풀</td>
    <td class="out" style="opacity:.6;">0% (없음)</td>
    <td><input type="number" id="bounty-ratio-input" value="50" data-role="bountyratio" style="width:70px;"></td></tr>`;
  t.innerHTML = html;
}

/* ---------- Rounds (buyin / rank result / bounty) ---------- */
function buildRound(rIdx){
  const roundNo = rIdx+1;
  const label = ROUND_LABELS[rIdx];
  const container = document.getElementById('roundsContainer');
  const card = el('div',{class:'card', id:`round-card-${roundNo}`});
  card.innerHTML = `<h2><span style="flex:1;">${label}</span>
    <select id="gtype-${roundNo}" data-role="gtype" title="게임 유형" style="width:6.5em; min-width:0; flex:none;">
      <option value="bounty">바운티</option>
      <option value="normal">일반</option>
    </select></h2>`;
  const body = el('div',{class:'card-body'});

  // Buy-in table + Rank result table side-by-side (wraps on narrow screens)
  const topFlex = el('div',{class:'flex-row', style:'margin-bottom:16px;'});

  const buyinCell = el('div',{class:'flexcell wide'});
  buyinCell.innerHTML = `<div class="subhead">바이인</div>`;
  const buyinTableWrap = el('div',{class:'tablewrap'});
  let head = '<tr><th class="rowlabel">참가자</th><th>바이인</th><th>리바인1</th><th>리바인2</th><th>리바인3</th><th>리바인4</th><th>합계</th></tr>';
  let bodyRows = '';
  for(let i=1;i<=MAXP;i++){
    bodyRows += `<tr class="prow-${i}"><td class="rowlabel namecell"><span class="pname-${i}">참가자${i}</span></td>`;
    for(let s=0;s<=REBUY_SLOTS;s++){
      bodyRows += `<td>${buildBuyinSelectHtml(roundNo,i,s)}</td>`;
    }
    bodyRows += `<td class="out" id="buyin-sum-${roundNo}-${i}">0</td></tr>`;
  }
  bodyRows += `<tr><td class="rowlabel" colspan="6" style="text-align:right;">${label} 총 바이인 합계</td><td class="out" id="buyin-total-${roundNo}">0</td></tr>`;
  buyinTableWrap.innerHTML = `<table>${head}${bodyRows}</table>`;
  buyinCell.appendChild(buyinTableWrap);
  topFlex.appendChild(buyinCell);

  const rankCell = el('div',{class:'flexcell'});
  rankCell.innerHTML = `<div class="subhead">${label} 순위 결과</div>`;
  const rankTableWrap = el('div',{class:'tablewrap'});
  let rHead = '<tr><th>등수</th><th>참가자</th><th>상금</th></tr>';
  let rBody = '';
  for(let r=0;r<4;r++){
    rBody += `<tr><td class="rowlabel rank-label-out" data-r="${r}">-</td>
      <td><select id="rankwin-${roundNo}-${r}" data-role="rankwin" data-round="${roundNo}" data-r="${r}"><option value="">선택 안함</option></select></td>
      <td class="out" id="rankprize-${roundNo}-${r}">0</td></tr>`;
  }
  rankTableWrap.innerHTML = `<table>${rHead}${rBody}</table>`;
  rankCell.appendChild(rankTableWrap);
  topFlex.appendChild(rankCell);

  body.appendChild(topFlex);

  // 게임 유형이 '일반'일 때 바운티 영역 대신 표시되는 안내문 (bountyWrap 밖에 위치해 바운티 영역을 완전히 숨겨도 계속 보입니다)
  const gtypeNote = el('div', {id:`bounty-gtype-note-${roundNo}`, class:'hint', style:'display:none; margin:0 0 12px; font-weight:600;'});
  body.appendChild(gtypeNote);

  // Bounty table (full width — grows with participant count)
  const bountyWrap = el('div', {id:`bountyWrap-${roundNo}`});
  bountyWrap.innerHTML = `<div class="hint" style="margin:0 0 4px;">${label} 바운티 풀: <span class="out" id="bounty-pool-${roundNo}">0</span>원 (총 바이인 × 바운티 풀 비율)</div>
    <div class="hint" style="margin:0 0 8px;">최대개수 반영 비율 합계: <span class="out" id="bounty-fullratiosum-${roundNo}">0%</span></div>
    <div class="warn" id="bounty-warn-${roundNo}" style="display:none;"></div>`;
  const bountyTableWrap = el('div',{class:'tablewrap'});
  let bHead = `<tr><th class="rowlabel">등급</th><th>비율(%)</th><th>최대개수</th><th>사용/최대</th><th>1개당 금액(참고)</th>`;
  for(let i=1;i<=MAXP;i++){
    bHead += `<th class="prow-${i} namecell"><span class="pname-${i}">참가자${i}</span></th>`;
  }
  bHead += '</tr>';
  let bBody = '';
  for(let lv=0;lv<4;lv++){
    bBody += `<tr><td class="rowlabel"><input type="text" id="bl-label-${roundNo}-${lv}" style="width:60px;"></td>
      <td><input type="number" id="bl-ratio-${roundNo}-${lv}" data-role="blratio" data-round="${roundNo}" style="width:60px;"></td>
      <td><input type="number" min="0" id="bl-count-${roundNo}-${lv}" data-role="blcount" data-round="${roundNo}" style="width:60px;"></td>
      <td class="out" id="bl-used-${roundNo}-${lv}">0 / 0</td>
      <td class="out" id="bl-unit-${roundNo}-${lv}">0</td>`;
    for(let i=1;i<=MAXP;i++){
      bBody += `<td class="prow-${i}"><input type="number" min="0" value="0" id="bg-${roundNo}-${lv}-${i}" data-role="bgrid" data-round="${roundNo}" data-lv="${lv}" style="width:50px;"></td>`;
    }
    bBody += '</tr>';
  }
  bBody += `<tr><td class="rowlabel" colspan="5" style="text-align:right;">참가자별 바운티 총액</td>`;
  for(let i=1;i<=MAXP;i++){
    bBody += `<td class="out prow-${i}" id="bounty-ptotal-${roundNo}-${i}">0</td>`;
  }
  bBody += '</tr>';
  bountyTableWrap.innerHTML = `<table>${bHead}${bBody}</table>`;
  bountyWrap.appendChild(bountyTableWrap);
  body.appendChild(bountyWrap);

  card.appendChild(body);
  container.appendChild(card);

  // fill defaults for bounty levels
  DEFAULT_BOUNTY_LEVELS[rIdx].forEach((lvl,idx)=>{
    document.getElementById(`bl-label-${roundNo}-${idx}`).value = lvl.label;
    document.getElementById(`bl-ratio-${roundNo}-${idx}`).value = lvl.ratio;
    document.getElementById(`bl-count-${roundNo}-${idx}`).value = lvl.count;
  });
}

function buildBuyinSelectHtml(roundNo,i,slot){
  let opts = '';
  DEFAULT_BUYIN_OPTIONS.forEach(v=>{
    opts += `<option value="${v}">${v===0?'-':v.toLocaleString('ko-KR')}</option>`;
  });
  return `<select id="buyin-${roundNo}-${i}-${slot}" data-role="buyin" data-round="${roundNo}">${opts}</select>`;
}

/* ---------- Final table ---------- */
function buildFinalTable(){
  const t = document.getElementById('finalTable');
  let head = '<tr><th class="rowlabel">항목</th>';
  for(let i=1;i<=MAXP;i++) head += `<th class="prow-${i} namecell"><span class="pname-${i}">참가자${i}</span></th>`;
  head += '</tr>';
  let rows = '';
  rows += rowFinal('총 바이인','final-buyin');
  for(let r=1;r<=roundCount;r++){
    rows += rowFinal(ROUND_LABELS[r-1]+' 상금','final-prize-'+r);
    rows += rowFinal(ROUND_LABELS[r-1]+' 바운티','final-bounty-'+r, false, `final-bounty-row-${r}`);
  }
  rows += rowFinal('최종 처리금액','final-total', true);
  t.innerHTML = head + rows;
}
function rowFinal(label, idPrefix, bold, trId){
  let r = `<tr${trId?` id="${trId}"`:''}><td class="rowlabel"${bold?' style="font-weight:800;"':''}>${label}</td>`;
  for(let i=1;i<=MAXP;i++){
    r += `<td class="out prow-${i}" id="${idPrefix}-${i}">0</td>`;
  }
  r += '</tr>';
  return r;
}

/* ---------- Recalc ---------- */
function num(id){
  const e = document.getElementById(id);
  if(!e) return 0;
  const v = parseFloat(e.value);
  return isNaN(v) ? 0 : v;
}
function strval(id){
  const e = document.getElementById(id);
  return e ? e.value : '';
}

function updateVisibility(){
  const n = parseInt(document.getElementById('participantCount').value,10);
  for(let i=1;i<=MAXP;i++){
    document.querySelectorAll('.prow-'+i).forEach(elm=>{
      const show = i<=n;
      elm.style.display = show ? '' : 'none';
    });
  }
  return n;
}

function updateNamesAndSelects(n){
  // update pname spans
  for(let i=1;i<=MAXP;i++){
    document.querySelectorAll('.pname-'+i).forEach(s=> s.textContent = pname(i));
  }
  // update rank-win selects options
  for(let r=1;r<=roundCount;r++){
    for(let rr=0;rr<4;rr++){
      const sel = document.getElementById(`rankwin-${r}-${rr}`);
      if(!sel) continue;
      const cur = sel.value;
      let html = '<option value="">선택 안함</option>';
      for(let i=1;i<=n;i++){
        html += `<option value="${i}">${pname(i)}</option>`;
      }
      sel.innerHTML = html;
      if([...sel.options].some(o=>o.value===cur)) sel.value = cur;
    }
  }
  // update rank label cells
  for(let rr=0;rr<4;rr++){
    const lbl = document.getElementById('rank-label-'+rr).value || '-';
    document.querySelectorAll(`.rank-label-out[data-r="${rr}"]`).forEach(td=> td.textContent = lbl);
  }
}

function recalcAll(){
  const n = updateVisibility();
  updateNamesAndSelects(n);

  // 프라이즈 비율 — 일반게임 / 바운티게임 각각 별도로 설정 (모든 부 공통, 게임 유형에 따라 선택 적용)
  let bountyRankRatios = [0,1,2,3].map(r=>num('rank-ratio-'+r)/100);
  let bountyRankSum = bountyRankRatios.reduce((a,b)=>a+b,0);
  let bountyRatio = num('bounty-ratio-input')/100;
  const bountyRatioTotal = bountyRankSum + bountyRatio;
  const warnEl = document.getElementById('ratioWarning');
  if(Math.abs(bountyRatioTotal-1) > 0.0005){
    warnEl.style.display='';
    warnEl.textContent = `[바운티게임] 등수 비율 합계(${(bountyRankSum*100).toFixed(1)}%) + 바운티 풀 비율(${(bountyRatio*100).toFixed(1)}%) = ${(bountyRatioTotal*100).toFixed(1)}% — 100%가 되어야 정확히 소진됩니다.`;
  } else {
    warnEl.style.display='none';
  }
  document.getElementById('bountyRatioBox').innerHTML =
    `바운티게임 — 등수 비율 합계: <b>${(bountyRankSum*100).toFixed(1)}%</b> + 바운티 풀 비율: <b>${(bountyRatio*100).toFixed(1)}%</b> = <b class="${Math.abs(bountyRatioTotal-1)<0.0005?'pos':'neg'}">${(bountyRatioTotal*100).toFixed(1)}%</b>`;

  let normalRankRatios = [0,1,2,3].map(r=>num('rank-ratio-normal-'+r)/100);
  let normalRankSum = normalRankRatios.reduce((a,b)=>a+b,0);
  const warnElNormal = document.getElementById('ratioWarningNormal');
  if(Math.abs(normalRankSum-1) > 0.0005){
    warnElNormal.style.display='';
    warnElNormal.textContent = `[일반게임] 등수 비율 합계(${(normalRankSum*100).toFixed(1)}%) — 바운티가 없으므로 100%가 되어야 합니다.`;
  } else {
    warnElNormal.style.display='none';
  }
  document.getElementById('normalRatioBox').innerHTML =
    `일반게임 — 등수 비율 합계: <b class="${Math.abs(normalRankSum-1)<0.0005?'pos':'neg'}">${(normalRankSum*100).toFixed(1)}%</b> (바운티 없음)`;

  // final accumulators
  const finalBuyin = Array(MAXP+1).fill(0);
  const finalPrize = Array.from({length: roundCount+1}, ()=>({}));
  const finalBounty = Array.from({length: roundCount+1}, ()=>({}));
  for(let i=1;i<=MAXP;i++){
    for(let round=1; round<=roundCount; round++){ finalPrize[round][i]=0; finalBounty[round][i]=0; }
  }

  for(let round=1;round<=roundCount;round++){
    // buy-in sums
    let roundTotal = 0;
    for(let i=1;i<=n;i++){
      let sum = 0;
      for(let s=0;s<=REBUY_SLOTS;s++){
        sum += num(`buyin-${round}-${i}-${s}`);
      }
      finalBuyin[i] += sum;
      roundTotal += sum;
      const c = document.getElementById(`buyin-sum-${round}-${i}`);
      if(c) c.textContent = fmt(sum);
    }
    document.getElementById(`buyin-total-${round}`).textContent = fmt(roundTotal);

    // 게임 유형: '일반'이면 일반게임 비율(바운티 없음)을, '바운티'면 바운티게임 비율을 적용합니다.
    const gtype = strval(`gtype-${round}`) || 'bounty';
    let effRankRatios, effBountyRatio;
    if(gtype === 'normal'){
      effRankRatios = normalRankRatios;
      effBountyRatio = 0;
    } else {
      effRankRatios = bountyRankRatios;
      effBountyRatio = bountyRatio;
    }
    const gtypeNoteEl = document.getElementById(`bounty-gtype-note-${round}`);
    const bountyWrapEl = document.getElementById(`bountyWrap-${round}`);
    if(gtypeNoteEl){
      if(gtype === 'normal'){
        gtypeNoteEl.style.display = '';
        gtypeNoteEl.textContent = `이 부는 게임 유형이 "일반"이라 바운티 없이, "일반게임 비율" 설정대로 바이인 전액이 순위 상금으로만 배분됩니다.`;
      } else {
        gtypeNoteEl.style.display = 'none';
      }
    }
    if(bountyWrapEl) bountyWrapEl.style.display = (gtype === 'normal') ? 'none' : '';
    // 최종 처리금액 표에서도 일반게임인 부는 바운티가 존재하지 않으므로 "N부 바운티" 행 자체를 숨깁니다.
    const finalBountyRowEl = document.getElementById(`final-bounty-row-${round}`);
    if(finalBountyRowEl) finalBountyRowEl.style.display = (gtype === 'normal') ? 'none' : '';

    // rank prizes
    for(let rr=0;rr<4;rr++){
      const ratio = effRankRatios[rr];
      const amount = roundTotal * ratio;
      document.getElementById(`rankprize-${round}-${rr}`).textContent = fmt(amount);
      const winner = strval(`rankwin-${round}-${rr}`);
      if(winner){
        finalPrize[round][winner] = (finalPrize[round][winner]||0) + amount;
      }
    }

    // bounty pool
    const bountyPool = roundTotal * effBountyRatio;
    document.getElementById(`bounty-pool-${round}`).textContent = fmt(bountyPool);

    const levelRatios = [];
    for(let lv=0;lv<4;lv++){
      const ratio = num(`bl-ratio-${round}-${lv}`)/100;
      levelRatios.push(ratio);
      const unit = bountyPool*ratio;
      const uEl = document.getElementById(`bl-unit-${round}-${lv}`);
      if(uEl) uEl.textContent = fmt(unit);
    }

    const usedByLevel = [0,0,0,0];
    for(let i=1;i<=n;i++){
      let pBounty = 0;
      for(let lv=0;lv<4;lv++){
        const cnt = num(`bg-${round}-${lv}-${i}`);
        usedByLevel[lv] += cnt;
        pBounty += cnt * levelRatios[lv] * bountyPool;
      }
      finalBounty[round][i] = pBounty;
      const bEl = document.getElementById(`bounty-ptotal-${round}-${i}`);
      if(bEl) bEl.textContent = fmt(pBounty);
    }

    // 최대개수 반영 비율 합계 표시 (비율 × 최대개수의 합)
    let fullRatioSumPct = 0;
    for(let lv=0;lv<4;lv++){
      const maxCountForRatio = num(`bl-count-${round}-${lv}`);
      fullRatioSumPct += levelRatios[lv] * maxCountForRatio;
    }
    fullRatioSumPct *= 100;
    const frsEl = document.getElementById(`bounty-fullratiosum-${round}`);
    if(frsEl){
      frsEl.textContent = fullRatioSumPct.toFixed(1) + '%';
      frsEl.classList.remove('pos','neg');
      frsEl.classList.add(Math.abs(fullRatioSumPct-100) < 0.05 ? 'pos' : 'neg');
    }

    // 등급별 최대 개수 대비 사용량 표시(초과 시 경고)
    let anyOver = false;
    for(let lv=0;lv<4;lv++){
      const maxc = num(`bl-count-${round}-${lv}`);
      const used = usedByLevel[lv];
      const cellEl = document.getElementById(`bl-used-${round}-${lv}`);
      if(cellEl){
        cellEl.textContent = `${used} / ${maxc}`;
        cellEl.classList.remove('neg','pos');
        if(used > maxc){ cellEl.classList.add('neg'); anyOver = true; }
        else { cellEl.classList.add('pos'); }
      }
    }
    const bwEl = document.getElementById(`bounty-warn-${round}`);
    if(bwEl){
      if(anyOver){
        bwEl.style.display = '';
        bwEl.textContent = `${ROUND_LABELS[round-1]}: 일부 등급에서 참가자에게 배정된 바운티 개수가 최대 개수를 초과했습니다. 확인해주세요.`;
      } else {
        bwEl.style.display = 'none';
      }
    }
  }

  // final table
  let grandCheck = 0;
  for(let i=1;i<=MAXP;i++){
    const buyinVal = -finalBuyin[i];
    document.getElementById('final-buyin-'+i).textContent = fmtSigned(buyinVal);
    let totalFinal = buyinVal;
    for(let round=1;round<=roundCount;round++){
      const pv = finalPrize[round][i]||0;
      const bv = finalBounty[round][i]||0;
      document.getElementById(`final-prize-${round}-${i}`).textContent = fmtSigned(pv);
      document.getElementById(`final-bounty-${round}-${i}`).textContent = fmtSigned(bv);
      totalFinal += pv + bv;
    }
    const totalEl = document.getElementById('final-total-'+i);
    totalEl.textContent = fmtSigned(totalFinal);
    totalEl.className = 'out prow-'+i+' '+(totalFinal>0.5?'pos':(totalFinal<-0.5?'neg':''));
    if(i<=n) grandCheck += totalFinal;
  }
  const checkEl = document.getElementById('finalCheck');
  const ok = Math.abs(grandCheck) < 1;
  checkEl.innerHTML = `<span class="${ok?'pos':'neg'}">${fmtSigned(grandCheck)}</span> ` + (ok? '<span class="badge ok">정상</span>' : '<span class="badge bad">확인필요</span>');
}
function fmtSigned(n){
  const r = Math.round(n);
  if(r>0) return '+'+r.toLocaleString('ko-KR');
  return r.toLocaleString('ko-KR');
}

/* ---------- Export ---------- */
function exportCSV(){
  const n = parseInt(document.getElementById('participantCount').value,10);
  let header = ['참가자','총 바이인'];
  for(let r=1;r<=roundCount;r++){
    header.push(`${ROUND_LABELS[r-1]} 상금`, `${ROUND_LABELS[r-1]} 바운티`);
  }
  header.push('최종 처리금액');
  let rows = [header];
  for(let i=1;i<=n;i++){
    let row = [pname(i), document.getElementById('final-buyin-'+i).textContent];
    for(let r=1;r<=roundCount;r++){
      const prizeEl = document.getElementById(`final-prize-${r}-${i}`);
      const bountyEl = document.getElementById(`final-bounty-${r}-${i}`);
      row.push(prizeEl ? prizeEl.textContent : '0', bountyEl ? bountyEl.textContent : '0');
    }
    row.push(document.getElementById('final-total-'+i).textContent);
    rows.push(row);
  }
  const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob(["﻿"+csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dayLabel = (sessions[currentSessionIndex] && sessions[currentSessionIndex].label) || 'day';
  a.href = url;
  a.download = `홀덤정산_${dayLabel}`.replace(/[\\/:*?"<>|]/g,'_') + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 바로 해제하면 브라우저에 따라 파일명이 'download'로 바뀌거나 받기가 실패함 → 잠시 뒤 해제
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

/* ---------- Multi-day (session) management ---------- */
let sessions = [];
let currentSessionIndex = 0;
let baseDefaultState = null;
let hiddenTabsVisible = false;
let roundCount = 0;
let currentRoundIndex = 1;
let currentTheme = 'light';

function cloneState(s){ return Object.assign({}, s); }

function collectState(){
  const state = {};
  document.querySelectorAll('#appRoot input, #appRoot select').forEach(elm=>{
    if(elm.id) state[elm.id] = elm.value;
  });
  return state;
}
function applyState(state){
  // 순위결과 드롭다운(rankwin-*)의 <option> 목록은 참가자 수(n)에 맞춰 매번 새로 그려지는데,
  // 아래에서 값을 대입하기 "전"에 이 날짜(state)의 참가자 수만큼 옵션이 미리 준비되어 있어야 합니다.
  // 그렇지 않으면(예: 참가자 수가 더 적은 날짜에서 더 많은 날짜로 전환할 때) 아직 좁은 옵션 목록만
  // 있는 상태에서 더 큰 번호의 참가자를 값으로 넣으려다 조용히 실패해, 1위/2위 등 순위 결과가
  // 빈 값으로 사라지는 문제가 있었습니다.
  const targetN = parseInt(state['participantCount'], 10) || parseInt(document.getElementById('participantCount').value,10) || MAXP;
  updateNamesAndSelects(targetN);
  document.querySelectorAll('#appRoot input, #appRoot select').forEach(elm=>{
    if(!elm.id) return;
    if(elm.id in state) elm.value = state[elm.id];
    // 이 날짜가 저장된 뒤에 새로 추가된 부(라운드) 등의 필드는 state에 값이 없으므로,
    // 다른 날짜의 값이 남아있지 않도록 기본값으로 되돌립니다.
    else if(baseDefaultState && (elm.id in baseDefaultState)) elm.value = baseDefaultState[elm.id];
  });
  recalcAll();
}

/* ---------- Rounds (부) tabs — 1부/2부/3부... 를 탭으로 전환, "+ 부 추가"로 확장 ---------- */
function renderRoundTabs(){
  const bar = document.getElementById('roundTabsBar');
  if(!bar) return;
  let html = '';
  for(let r=1;r<=roundCount;r++){
    const active = r===currentRoundIndex;
    html += `<div class="daytab roundtab ${active?'active':''}" data-round="${r}">
      <span class="daytab-label">${escapeHtml(ROUND_LABELS[r-1])}</span>
      ${roundCount>1 ? `<button type="button" class="dtbtn" data-action="deleteround" data-round="${r}" title="이 부 삭제">×</button>` : ''}
    </div>`;
  }
  html += `<button type="button" class="daytab-add" id="btnAddRound">+ 부 추가</button>`;
  bar.innerHTML = html;
}
function switchRound(r){
  currentRoundIndex = r;
  for(let i=1;i<=roundCount;i++){
    const card = document.getElementById(`round-card-${i}`);
    if(card) card.style.display = (i===r) ? '' : 'none';
  }
  renderRoundTabs();
}
function ensureRoundsBuilt(targetCount){
  while(roundCount < targetCount){
    roundCount++;
    const newIdx = roundCount;
    if(!ROUND_LABELS[newIdx-1]) ROUND_LABELS.push(`${newIdx}부`);
    if(!DEFAULT_BOUNTY_LEVELS[newIdx-1]){
      const lastLevels = DEFAULT_BOUNTY_LEVELS[DEFAULT_BOUNTY_LEVELS.length-1];
      DEFAULT_BOUNTY_LEVELS.push(lastLevels.map(l=>Object.assign({}, l)));
    }
    buildRound(newIdx-1);
    // 새로 만들어진 부의 입력 요소들은 지금 값(빌드 시 채워진 기본값)을 baseDefaultState에 등록해둡니다.
    // 이렇게 해야 이 부가 생기기 전에 저장된 다른 날짜로 전환할 때, 엉뚱한 값이 남지 않고 기본값으로 돌아갑니다.
    if(baseDefaultState){
      document.querySelectorAll(`#round-card-${newIdx} input, #round-card-${newIdx} select`).forEach(elm=>{
        if(elm.id) baseDefaultState[elm.id] = elm.value;
      });
    }
  }
}
// 부(라운드)는 날짜마다 따로 갖습니다. 추가/삭제는 지금 보고 있는 날짜에만 적용되고 다른 날짜에는 영향이 없습니다.
function addRound(){
  const day = sessions[currentSessionIndex];
  const st = collectState();
  st[ROUND_COUNT_KEY] = String(roundCount + 1);
  day.state = st;
  loadDay(currentSessionIndex);
  switchRound(roundCount);
  markDayDirty(day);
}

// 부(라운드) 삭제 시, 그 부보다 뒤에 있는 부들의 번호가 하나씩 앞으로 당겨집니다.
// 이 함수는 저장된 상태(state) 안의 필드 id에 박혀있는 부 번호를 그에 맞게 다시 매핑합니다.
// 예: 2부를 삭제하면 -> 기존 3부의 데이터(id의 "-3-")가 새 2부(id의 "-2-")로 옮겨지고, 기존 2부 데이터는 버려집니다.
const ROUND_KEYED_PREFIXES = ['gtype','buyin','rankwin','bl-label','bl-ratio','bl-count','bg'];
function remapRoundKeysInState(state, deletedRound){
  const newState = {};
  Object.keys(state).forEach(key=>{
    for(const prefix of ROUND_KEYED_PREFIXES){
      const m = key.match(new RegExp('^'+prefix+'-(\\d+)(-.*)?$'));
      if(m){
        const r = parseInt(m[1],10);
        const rest = m[2] || '';
        if(r === deletedRound) return; // 삭제된 부의 데이터는 버립니다.
        const newR = r > deletedRound ? r-1 : r;
        newState[`${prefix}-${newR}${rest}`] = state[key];
        return;
      }
    }
    newState[key] = state[key];
  });
  return newState;
}
function deleteRound(r){
  if(roundCount<=1){ alert('마지막 부는 삭제할 수 없습니다.'); return; }
  const day = sessions[currentSessionIndex];
  const lbl = ROUND_LABELS[r-1] || `${r}부`;
  if(!confirm(`'${day.label}' 날짜의 '${lbl}'를 삭제할까요?\n이 날짜의 ${lbl} 데이터만 사라지며 다른 날짜에는 영향이 없습니다. 되돌릴 수 없습니다.`)) return;
  // 이 날짜의 값만 새 번호 체계로 옮김 (뒤의 부가 한 칸씩 앞으로)
  const st = remapRoundKeysInState(collectState(), r);
  st[ROUND_COUNT_KEY] = String(roundCount - 1);
  day.state = st;
  loadDay(currentSessionIndex);
  switchRound(Math.min(r, roundCount));
  markDayDirty(day);
}
function roundTabsClickHandler(e){
  if(e.target.id === 'btnAddRound'){ addRound(); return; }
  const delBtn = e.target.closest('[data-action="deleteround"]');
  if(delBtn){ deleteRound(parseInt(delBtn.dataset.round,10)); return; }
  const tab = e.target.closest('.roundtab');
  if(tab) switchRound(parseInt(tab.dataset.round,10));
}

/* ---------- Theme (dark/light) ---------- */
function applyTheme(theme){
  // 기본값은 '라이트'입니다 — 저장된 파일에 테마 정보가 없던 예전 파일을 열 때도 라이트로 보입니다.
  currentTheme = (theme === 'dark') ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  const mi = document.getElementById('miThemeToggle');
  if(mi) mi.textContent = currentTheme === 'light' ? '🌙 다크 모드' : '☀️ 라이트 모드';
}
function toggleTheme(){
  // 화면 모드는 클라우드에 동기화하지 않는 개인 표시 설정입니다 (파일로 저장할 때만 함께 저장됩니다).
  applyTheme(currentTheme === 'light' ? 'dark' : 'light');
  lsSet(LS_THEME, currentTheme);
}
function defaultDayLabel(){
  const d = new Date();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${mm}/${dd} 게임`;
}
function renderDayTabs(){
  const bar = document.getElementById('dayTabsBar');
  const prevScroll = bar.scrollLeft;
  let html = '';
  sessions.forEach((s,idx)=>{
    if(s.hidden) return;
    const active = idx===currentSessionIndex;
    html += `<div class="daytab ${active?'active':''}" data-idx="${idx}" draggable="true">
      <span class="daytab-label" data-idx="${idx}" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>${settleBadgeHtml(s)}
      <div class="dtdropdown" data-idx="${idx}">
        <button type="button" class="dtbtn" data-action="togglemenu" data-idx="${idx}" title="더보기">⋯</button>
        <div class="dtdropdown-menu" data-idx="${idx}">
          <button type="button" class="dropdown-item" data-action="rename" data-idx="${idx}">명칭 변경</button>
          <button type="button" class="dropdown-item" data-action="hide" data-idx="${idx}">숨기기</button>
          <button type="button" class="dropdown-item mi-warn" data-action="reset" data-idx="${idx}">초기화</button>
          <button type="button" class="dropdown-item mi-danger" data-action="delete" data-idx="${idx}">삭제</button>
        </div>
      </div>
    </div>`;
  });
  bar.innerHTML = html;
  const hiddenList = sessions.filter(s=>s.hidden);
  const miToggleHidden = document.getElementById('miToggleHidden');
  if(miToggleHidden){
    if(hiddenList.length){
      miToggleHidden.style.display = '';
      miToggleHidden.textContent = `${hiddenTabsVisible ? '숨긴 날짜 접기' : '숨긴 날짜 보기'} (${hiddenList.length})`;
    } else {
      miToggleHidden.style.display = 'none';
    }
  }

  const hiddenBar = document.getElementById('hiddenDayTabsBar');
  if(hiddenTabsVisible && hiddenList.length){
    let hh = '';
    sessions.forEach((s,idx)=>{
      if(!s.hidden) return;
      hh += `<div class="daytab hiddenday" data-idx="${idx}">
        <span class="daytab-label">${escapeHtml(s.label)}</span>${settleBadgeHtml(s)}
        <div class="dtdropdown" data-idx="${idx}">
          <button type="button" class="dtbtn" data-action="togglemenu" data-idx="${idx}" title="더보기">⋯</button>
          <div class="dtdropdown-menu" data-idx="${idx}">
            <button type="button" class="dropdown-item" data-action="unhide" data-idx="${idx}">숨김 해제</button>
            <button type="button" class="dropdown-item mi-danger" data-action="delete" data-idx="${idx}">삭제</button>
          </div>
        </div>
      </div>`;
    });
    hiddenBar.innerHTML = hh;
    hiddenBar.style.display = 'flex';
  } else {
    hiddenBar.innerHTML = '';
    hiddenBar.style.display = 'none';
  }
  afterDayTabsRender(prevScroll);
}
function switchToDay(idx){
  if(idx===currentSessionIndex) return;
  sessions[currentSessionIndex].state = collectState();
  loadDay(idx);
  rememberCurrentDay();
}
function loadDay(idx){
  currentSessionIndex = idx;
  const st = sessions[idx].state || defaultStateForRounds(defaultRoundCount);
  const n = dayRoundCountOf(st);
  if(n !== roundCount){ rebuildRounds(n); buildFinalTable(); }
  applyState(st);
  document.getElementById(ROUND_COUNT_KEY).value = String(n);
  switchRound(Math.min(Math.max(currentRoundIndex, 1), roundCount));
  renderDayTabs();
}
function addDay(){
  sessions[currentSessionIndex].state = collectState();
  const s = newSession(defaultDayLabel(), defaultStateForRounds(defaultRoundCount));
  sessions.push(s);
  loadDay(sessions.length-1);
  rememberCurrentDay();
  orderDirty = true;
  markDayDirty(s);
}
function renameDay(idx){
  const cur = sessions[idx].label;
  const next = prompt('날짜(회차) 이름을 입력하세요', cur);
  if(next && next.trim()){
    sessions[idx].label = next.trim();
    renderDayTabs();
    markDayDirty(sessions[idx]);
  }
}
function hideDay(idx){
  const visibleCount = sessions.filter(s=>!s.hidden).length;
  if(visibleCount<=1){ alert('최소 1개의 날짜는 보이는 상태여야 합니다.'); return; }
  sessions[idx].hidden = true;
  if(currentSessionIndex===idx){
    const nextIdx = sessions.findIndex(s=>!s.hidden);
    loadDay(nextIdx);
  } else {
    renderDayTabs();
  }
  markDayDirty(sessions[idx]);
}
function unhideDay(idx){
  sessions[idx].hidden = false;
  renderDayTabs();
  markDayDirty(sessions[idx]);
}
function resetDay(idx){
  const label = sessions[idx] ? sessions[idx].label : '해당 날짜';
  if(!confirm(`'${label}'의 입력값을 모두 초기화할까요? 되돌릴 수 없습니다.`)) return;
  const keepRounds = dayRoundCountOf(idx === currentSessionIndex ? collectState() : sessions[idx].state);
  sessions[idx].state = defaultStateForRounds(keepRounds);
  if(idx === currentSessionIndex) loadDay(idx);
  markDayDirty(sessions[idx]);
}
function deleteDay(idx){
  if(sessions.length<=1){ alert('마지막 날짜는 삭제할 수 없습니다.'); return; }
  const settledRun = activeRunForDay(sessions[idx].id);
  const settledNote = settledRun ? `\n\n이 날짜는 '${settledRun.name}' 정산에 포함되어 있습니다. 삭제해도 정산 이력(당시 금액)은 그대로 남습니다.` : '';
  if(!confirm(`'${sessions[idx].label}' 날짜를 삭제할까요? 이 날짜의 모든 입력 기록이 사라지며 되돌릴 수 없습니다.${settledNote}`)) return;
  noteDeleted(sessions[idx]);
  sessions.splice(idx,1);
  if(currentSessionIndex===idx){
    const fallback = sessions.findIndex(s=>!s.hidden);
    loadDay(fallback>=0 ? fallback : Math.min(idx, sessions.length-1));
  } else if(currentSessionIndex>idx){
    currentSessionIndex--;
    renderDayTabs();
  } else {
    renderDayTabs();
  }
  rememberCurrentDay();
  scheduleSave();
}

/* ---------- Day tabs click handling ---------- */
function closeAllDayMenus(except){
  document.querySelectorAll('.dtdropdown.open').forEach(el=>{
    if(el !== except) el.classList.remove('open');
  });
}
function toggleMoreMenu(){
  const open = document.getElementById('moreMenuWrap').classList.toggle('open');
  if(!open) setSettleGroupOpen(false);
}
function closeMoreMenu(){
  document.getElementById('moreMenuWrap').classList.remove('open');
  setSettleGroupOpen(false);
}
function setSettleGroupOpen(open){
  const g = document.getElementById('miSettleGroup'), sub = document.getElementById('miSettleSub');
  if(!g || !sub) return;
  g.setAttribute('aria-expanded', open ? 'true' : 'false');
  sub.hidden = !open;
}
function toggleDayMoreMenu(){
  document.getElementById('dayMoreMenuWrap').classList.toggle('open');
}
function closeDayMoreMenu(){
  document.getElementById('dayMoreMenuWrap').classList.remove('open');
}
function dayTabsClickHandler(e){
  const toggleBtn = e.target.closest('[data-action="togglemenu"]');
  if(toggleBtn){
    e.stopPropagation();
    const wrap = toggleBtn.closest('.dtdropdown');
    const wasOpen = wrap.classList.contains('open');
    closeAllDayMenus();
    wrap.classList.toggle('open', !wasOpen);
    if(!wasOpen) positionDayMenu(toggleBtn, wrap.querySelector('.dtdropdown-menu'));
    return;
  }
  const btn = e.target.closest('[data-action]');
  if(btn){
    e.stopPropagation();
    const idx = parseInt(btn.dataset.idx,10);
    if(btn.dataset.action==='rename') renameDay(idx);
    else if(btn.dataset.action==='delete') deleteDay(idx);
    else if(btn.dataset.action==='hide') hideDay(idx);
    else if(btn.dataset.action==='unhide') unhideDay(idx);
    else if(btn.dataset.action==='reset') resetDay(idx);
    closeAllDayMenus();
    return;
  }
  const tab = e.target.closest('.daytab');
  if(tab && !tab.classList.contains('hiddenday')){ switchToDay(parseInt(tab.dataset.idx,10)); }
}

/* ---------- Day tab drag & drop reordering ---------- */
let dragSourceIdx = null;
function clearDragOverMarks(){
  document.querySelectorAll('#dayTabsBar .daytab').forEach(t=>{
    t.classList.remove('drag-over-before','drag-over-after','dragging');
  });
}
function moveSession(fromIdx, toIdx){
  if(fromIdx === toIdx) return;
  const activeSession = sessions[currentSessionIndex];
  const item = sessions.splice(fromIdx,1)[0];
  let insertAt = toIdx;
  if(fromIdx < toIdx) insertAt -= 1;
  if(insertAt < 0) insertAt = 0;
  if(insertAt > sessions.length) insertAt = sessions.length;
  sessions.splice(insertAt,0,item);
  currentSessionIndex = sessions.indexOf(activeSession);
  renderDayTabs();
  orderDirty = true;
  scheduleSave();
}
function dayTabsDragStart(e){
  const tab = e.target.closest('.daytab');
  if(!tab || tab.classList.contains('hiddenday')){ return; }
  dragSourceIdx = parseInt(tab.dataset.idx,10);
  e.dataTransfer.effectAllowed = 'move';
  try{ e.dataTransfer.setData('text/plain', String(dragSourceIdx)); }catch(err){}
  tab.classList.add('dragging');
}
function dayTabsDragOver(e){
  const tab = e.target.closest('.daytab');
  if(!tab || tab.classList.contains('hiddenday') || dragSourceIdx===null) return;
  e.preventDefault();
  document.querySelectorAll('#dayTabsBar .daytab').forEach(t=>{
    if(t!==tab) t.classList.remove('drag-over-before','drag-over-after');
  });
  const rect = tab.getBoundingClientRect();
  const before = (e.clientX - rect.left) < rect.width/2;
  tab.classList.toggle('drag-over-before', before);
  tab.classList.toggle('drag-over-after', !before);
}
function dayTabsDragLeave(e){
  const tab = e.target.closest('.daytab');
  if(tab) tab.classList.remove('drag-over-before','drag-over-after');
}
function dayTabsDrop(e){
  const tab = e.target.closest('.daytab');
  if(tab && !tab.classList.contains('hiddenday') && dragSourceIdx!==null){
    e.preventDefault();
    const targetIdx = parseInt(tab.dataset.idx,10);
    const rect = tab.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width/2;
    const insertIdx = targetIdx + (before?0:1);
    moveSession(dragSourceIdx, insertIdx);
  }
  dragSourceIdx = null;
  clearDragOverMarks();
}
function dayTabsDragEnd(e){
  dragSourceIdx = null;
  clearDragOverMarks();
}

/* ===================== 서버(구글 시트) 동기화 =====================
 * 데이터 보호 원칙
 *  - 서버에서 최신 데이터를 정상적으로 받기 전에는 절대 저장하지 않습니다.
 *  - 바뀐 날짜만 서버로 보냅니다. 날짜 삭제는 "삭제" 메뉴를 눌렀을 때만 서버에 전달됩니다.
 *  - 날짜마다 버전을 같이 보내, 다른 기기가 먼저 고친 날짜는 서버가 거절합니다(덮어쓰기 방지).
 */
const LS_PASS = 'holdem-passcode';
const LS_THEME = 'holdem-theme';
const LS_DAY = 'holdem-last-day';
let syncReady = false;
let syncBlockedReason = 'loading';
let orderDirty = false;
let metaDirty = false;
let pendingDeletes = [];
let saveTimer = null;
let saveInFlight = false;
let saveQueued = false;
let retryDelay = 0;
let lastSavedAt = '';
let builtRoundSig = '';
// 부 개수: 날짜마다 state['round-count']에 저장. 값이 없는 예전 날짜는 defaultRoundCount(시트 meta, 기본 3)로 보여줍니다.
const ROUND_COUNT_KEY = 'round-count';
let defaultRoundCount = 3;
const ROUND_KEY_RE = /^(gtype|buyin|rankwin|bl-label|bl-ratio|bl-count|bg)-(\d+)/;
function dayRoundCountOf(st){
  const v = st && Object.prototype.hasOwnProperty.call(st, ROUND_COUNT_KEY) ? String(st[ROUND_COUNT_KEY]) : '';
  return /^[1-9]\d?$/.test(v) ? parseInt(v, 10) : defaultRoundCount;
}
function defaultStateForRounds(n){
  const st = {};
  Object.keys(baseDefaultState).forEach(k=>{ const m = k.match(ROUND_KEY_RE); if(m && parseInt(m[2], 10) > n) return; st[k] = baseDefaultState[k]; });
  st[ROUND_COUNT_KEY] = String(n);
  return st;
}
function defaultRoundLabels(){ return Array.from({length: defaultRoundCount}, (_, i)=>ROUND_LABELS[i] || `${i+1}부`); }

function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }

function newDayId(){
  const a = new Uint8Array(4);
  window.crypto.getRandomValues(a);
  return 'd' + Date.now().toString(36) + Array.from(a, b=>b.toString(16).padStart(2,'0')).join('').slice(0,6);
}
function newSession(label, state){
  return {id: newDayId(), label, state, hidden:false, version:0, editSeq:1, savedSeq:0};
}
function isDirty(s){ return s.editSeq !== s.savedSeq; }
function markDayDirtyNoSchedule(s){ if(s) s.editSeq++; }
function markDayDirty(s){ markDayDirtyNoSchedule(s); scheduleSave(); scheduleSettleBadgeRefresh(); }
function markMetaDirty(){ metaDirty = true; scheduleSave(); }
function noteDeleted(s){ if(s && s.version > 0) pendingDeletes.push({id: s.id, baseVersion: s.version}); }
function hasUnsaved(){ return sessions.some(isDirty) || pendingDeletes.length > 0 || orderDirty || metaDirty; }
function rememberCurrentDay(){ const s = sessions[currentSessionIndex]; if(s) lsSet(LS_DAY, s.id); }
function roundSig(){ return roundCount + '|' + ROUND_LABELS.slice(0, roundCount).join('|'); }

async function api(path, opts = {}){
  const headers = {'Content-Type': 'application/json'};
  const pass = lsGet(LS_PASS);
  if(pass) headers['x-app-passcode'] = pass;
  let res;
  try{
    res = await fetch(path, {method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined});
  }catch(e){
    const err = new Error('서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.');
    err.network = true;
    throw err;
  }
  let json = null;
  try{ json = await res.json(); }catch(e){}
  if(!res.ok){
    const err = new Error((json && json.message) || `서버 오류 (${res.status})`);
    err.status = res.status; err.code = json && json.error; err.data = json || {};
    throw err;
  }
  return json;
}

function setBanner(text, btnLabel, onClick){
  const b = document.getElementById('syncBanner');
  if(!text){ b.style.display = 'none'; return; }
  document.getElementById('syncBannerText').textContent = text;
  const btn = document.getElementById('btnSyncRetry');
  if(btnLabel){ btn.style.display = ''; btn.textContent = btnLabel; btn.onclick = onClick; }
  else { btn.style.display = 'none'; btn.onclick = null; }
  b.style.display = 'flex';
}
function setSaveStatus(text, cls){
  const e = document.getElementById('saveStatus');
  e.textContent = text || '';
  e.className = 'save-status' + (cls ? ' ' + cls : '');
}

function rebuildRounds(n){
  document.getElementById('roundsContainer').innerHTML = '';
  roundCount = 0;
  ensureRoundsBuilt(n);
  builtRoundSig = roundSig();
}

// 서버 데이터로 화면 전체를 교체
function applyServerDataset(ds){
  defaultRoundCount = Math.max(1, parseInt(ds.roundCount, 10) || 3);
  if(Array.isArray(ds.roundLabels)) ds.roundLabels.forEach((l, i)=>{ if(typeof l === 'string' && l) ROUND_LABELS[i] = l; });

  sessions = (ds.days || []).map(d=>({id: d.id, label: d.label, hidden: !!d.hidden, version: d.version, state: d.state, editSeq: 0, savedSeq: 0}));
  pendingDeletes = []; orderDirty = false; metaDirty = false;
  if(!sessions.length) sessions = [newSession(defaultDayLabel(), defaultStateForRounds(defaultRoundCount))];

  const visibleIdx = (id)=> sessions.findIndex(s=>s.id === id && !s.hidden);
  let idx = visibleIdx(lsGet(LS_DAY));
  if(idx < 0) idx = visibleIdx(ds.currentDayId);
  if(idx < 0){
    for(let i = sessions.length - 1; i >= 0; i--) if(!sessions[i].hidden){ idx = i; break; }
  }
  if(idx < 0) idx = 0;
  loadDay(idx);
}

async function loadFromServer(){
  syncReady = false;
  syncBlockedReason = 'loading';
  clearTimeout(saveTimer);
  setBanner('서버에서 최신 데이터를 불러오는 중입니다… (완료 전에는 저장되지 않습니다)');
  let data;
  try{
    data = await api('/api/data');
  }catch(e){
    if(e.status === 401 && e.code === 'passcode'){
      setBanner('비밀번호를 입력해야 장부를 불러올 수 있습니다.');
      askPasscode();
      return false;
    }
    syncBlockedReason = 'error';
    setBanner(`서버에서 데이터를 불러오지 못해 저장을 멈춰두었습니다. 시트의 기존 데이터는 안전합니다. (${e.message})`, '다시 불러오기', ()=>reloadFromServer());
    return false;
  }
  settlements = data.settlements || [];
  if(data.status === 'migration_pending'){
    applyServerDataset(data.dataset);
    syncBlockedReason = 'migration';
    setBanner(`기존 데이터(${data.legacy ? data.legacy.days : '?'}개 날짜)를 새 구조로 옮기는 작업이 아직 진행되지 않았습니다. 관리자 페이지에서 먼저 이전해주세요. (그 전에는 저장되지 않습니다)`, '관리자 페이지', ()=>{ location.href = '/admin'; });
    return false;
  }
  applyServerDataset(data.dataset);
  if(data.readOnly){
    syncBlockedReason = 'readonly';
    setBanner('안전을 위해 저장이 잠겨 있습니다: ' + data.readOnly);
    return false;
  }
  syncReady = true;
  syncBlockedReason = null;
  setBanner(null);
  setSaveStatus(lastSavedAt ? `저장됨 · ${lastSavedAt}` : '');
  if(hasUnsaved()) scheduleSave(); // 완전히 비어있는 새 시트라면 첫 날짜를 저장
  return true;
}

async function reloadFromServer(){
  if(hasUnsaved() && !confirm('이 기기에서 아직 저장되지 않은 변경이 있습니다.\n서버의 최신 데이터를 불러오면 이 변경은 사라집니다.\n(취소한 뒤 더보기 › 전체 데이터 다운로드로 먼저 백업할 수 있습니다)\n\n계속할까요?')) return;
  await loadFromServer();
}

function datasetSig(days, rc, labels){
  return days.map(d=>`${d.id}:${d.version}:${d.hidden ? 1 : 0}`).join('|') + '#' + rc + '#' + labels.slice(0, rc).join('|');
}
// 다른 기기에서 바뀐 내용이 있으면 조용히 불러오기 (이 기기에 저장 안 된 변경이 있으면 건너뜀)
async function refreshIfChanged(){
  if(!syncReady || saveInFlight || hasUnsaved()) return;
  let data;
  try{ data = await api('/api/data'); }catch(e){ return; }
  if(data.status !== 'ok' || data.readOnly) return;
  if(!syncReady || saveInFlight || hasUnsaved()) return;
  const remote = datasetSig(data.dataset.days, data.dataset.roundCount, data.dataset.roundLabels);
  const local = datasetSig(sessions, defaultRoundCount, defaultRoundLabels());
  const settleChanged = settleSig(data.settlements || []) !== settleSig(settlements);
  if(remote !== local){
    settlements = data.settlements || [];
    applyServerDataset(data.dataset);
    showToast('다른 기기에서 바뀐 내용을 불러왔습니다.');
  } else if(settleChanged){
    settlements = data.settlements || [];
    renderDayTabs();
  }
  if(settleChanged && isSettleOpen()) rerenderSettle();
}

function scheduleSave(){
  if(!syncReady) return; // 불러오기 전/실패/충돌 상태에서는 저장하지 않음 (배너로 안내 중)
  clearTimeout(saveTimer);
  setSaveStatus('저장 대기 중…', 'saving');
  saveTimer = setTimeout(doSave, 1500);
}

async function doSave(){
  if(!syncReady) return;
  if(saveInFlight){ saveQueued = true; return; }
  if(!hasUnsaved()){ setSaveStatus(lastSavedAt ? `저장됨 · ${lastSavedAt}` : ''); return; }
  sessions[currentSessionIndex].state = collectState();
  const sent = sessions.filter(isDirty).map(s=>({s, seq: s.editSeq}));
  const payload = {
    changes: sent.map(({s})=>({id: s.id, baseVersion: s.version, label: s.label, hidden: !!s.hidden, state: cloneState(s.state || baseDefaultState)})),
    deletes: pendingDeletes.slice(),
    currentDayId: (sessions[currentSessionIndex] || {}).id,
  };
  const sentOrder = orderDirty, sentMeta = metaDirty, sentDeletes = payload.deletes.length;
  if(sentOrder) payload.order = sessions.map(s=>s.id);
  if(sentMeta) payload.meta = {roundCount: defaultRoundCount, roundLabels: defaultRoundLabels()};
  orderDirty = false; metaDirty = false;
  saveInFlight = true;
  setSaveStatus('저장 중…', 'saving');
  try{
    const r = await api('/api/save', {method: 'POST', body: payload});
    sent.forEach(({s, seq})=>{
      if(r.versions && r.versions[s.id] !== undefined) s.version = r.versions[s.id];
      s.savedSeq = seq; // 보내는 사이에 또 고쳤다면(editSeq 증가) 계속 "저장 필요" 상태로 남음
    });
    pendingDeletes = pendingDeletes.slice(sentDeletes);
    retryDelay = 0;
    lastSavedAt = new Date().toLocaleTimeString('ko-KR');
    setSaveStatus(`저장됨 · ${lastSavedAt}`);
    const localById = new Map(sessions.map(s=>[s.id, s]));
    const remoteChanged = (r.days || []).some(d=>{ const s = localById.get(d.id); return !s || s.version !== d.version; })
      || sessions.some(s=>s.version > 0 && !(r.days || []).some(d=>d.id === s.id))
      || r.roundCount !== defaultRoundCount;
    if(remoteChanged) setTimeout(refreshIfChanged, 400);
  }catch(e){
    if(sentOrder) orderDirty = true;
    if(sentMeta) metaDirty = true;
    if(e.status === 409 && e.code === 'CONFLICT'){
      syncReady = false; syncBlockedReason = 'conflict';
      const names = (e.data.conflicts || []).map(c=>`'${c.label}'`).join(', ');
      setSaveStatus('저장 중단됨', 'error');
      setBanner(`다른 기기에서 ${names} 날짜를 먼저 수정해서 저장을 멈췄습니다. 최신 데이터를 불러오면 이 기기에서 저장되지 않은 변경은 사라집니다. (필요하면 더보기 › 전체 데이터 다운로드로 먼저 백업하세요)`, '최신 데이터 불러오기', ()=>reloadFromServer());
    } else if(e.status === 401){
      syncReady = false; syncBlockedReason = 'error';
      setBanner('비밀번호가 바뀌었습니다. 다시 입력해주세요.');
      askPasscode();
    } else if(e.network || e.status === 502 || e.status === 503 || e.status === 504){
      retryDelay = Math.min(retryDelay ? retryDelay * 2 : 3000, 60000);
      setSaveStatus(`저장 실패 · ${Math.round(retryDelay / 1000)}초 후 다시 시도`, 'error');
      showToast('저장 실패: ' + e.message, true);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, retryDelay);
    } else {
      syncReady = false; syncBlockedReason = 'readonly';
      setSaveStatus('저장 안 됨', 'error');
      setBanner('저장하지 못했습니다: ' + e.message, '다시 불러오기', ()=>reloadFromServer());
    }
  }finally{
    saveInFlight = false;
    if(saveQueued){ saveQueued = false; if(syncReady && hasUnsaved()) scheduleSave(); }
  }
}

// 백업/복원 전에 저장 대기 중인 변경을 먼저 서버에 보냄
async function flushSave(){
  clearTimeout(saveTimer);
  for(let i = 0; i < 3 && syncReady && (saveInFlight || hasUnsaved()); i++){
    while(saveInFlight) await new Promise(r=>setTimeout(r, 100));
    if(syncReady && hasUnsaved()) await doSave();
  }
  return syncReady && !hasUnsaved();
}

/* ===================== 백업 ===================== */
const KIND_LABELS = {
  'manual': '수동 백업',
  'auto-daily': '자동 · 하루 첫 저장 전',
  'auto-before-delete': '자동 · 날짜 삭제 전',
  'auto-before-restore': '자동 · 복원 전',
  'migration-source': '이전 직전 원본',
};
function openModal(id){ document.getElementById(id).style.display = 'flex'; }
function closeModal(id){ document.getElementById(id).style.display = 'none'; }

function openBackupCreate(){
  if(!syncReady){ showToast('서버와 동기화된 상태에서만 백업할 수 있습니다.', true); return; }
  const day = sessions[currentSessionIndex];
  const nameEl = document.getElementById('backupName');
  nameEl.value = `${day ? day.label : ''} ${new Date().toLocaleString('ko-KR', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'})}`.trim();
  openModal('backupCreateOverlay');
  nameEl.focus(); nameEl.select();
}
async function confirmBackupCreate(){
  const name = document.getElementById('backupName').value.trim();
  if(!name){ showToast('백업 이름을 입력해주세요.', true); return; }
  if(!(await flushSave())){ showToast('저장되지 않은 변경이 있어 백업하지 못했습니다.', true); return; }
  try{
    await api('/api/backups', {method: 'POST', body: {name}});
    closeModal('backupCreateOverlay');
    showToast(`"${name}" 백업을 만들었습니다.`);
  }catch(e){ showToast('백업 실패: ' + e.message, true); }
}
async function openBackupList(){
  const list = document.getElementById('backupList');
  list.innerHTML = '<div class="empty-note">불러오는 중…</div>';
  openModal('backupListOverlay');
  let r;
  try{ r = await api('/api/backups'); }
  catch(e){ list.innerHTML = `<div class="empty-note">목록을 불러오지 못했습니다: ${escapeHtml(e.message)}</div>`; return; }
  if(!r.backups.length){ list.innerHTML = '<div class="empty-note">아직 백업이 없습니다.</div>'; return; }
  list.innerHTML = r.backups.map(b=>`
    <div class="cloud-load-item" data-id="${escapeHtml(b.id)}">
      <div class="cloud-load-info">
        <div style="min-width:0;">
          <div class="name">${escapeHtml(b.name)}</div>
          <div class="kind">${escapeHtml(KIND_LABELS[b.kind] || b.kind)} · ${escapeHtml(b.dayCount)}개 날짜 · ${escapeHtml(formatTime(b.createdAt))}</div>
        </div>
      </div>
      <div class="backup-item-actions">
        <button type="button" class="secondary" data-act="restore">복원</button>
        <button type="button" class="cloud-load-delete" data-act="delete" title="삭제">×</button>
      </div>
    </div>`).join('');
}
function formatTime(iso){ try{ return new Date(iso).toLocaleString('ko-KR'); }catch(e){ return iso; } }
async function backupListClick(e){
  const btn = e.target.closest('[data-act]');
  if(!btn) return;
  const item = btn.closest('.cloud-load-item');
  const id = item.dataset.id;
  const name = item.querySelector('.name').textContent;
  if(btn.dataset.act === 'restore'){
    if(!syncReady){ showToast('서버와 동기화된 상태에서만 복원할 수 있습니다.', true); return; }
    if(!confirm(`'${name}' 백업 시점으로 모든 날짜를 되돌릴까요?\n지금 상태는 복원 직전에 자동으로 한 번 더 백업됩니다.`)) return;
    if(!(await flushSave())){ showToast('저장되지 않은 변경이 있어 복원하지 못했습니다.', true); return; }
    try{
      const r = await api(`/api/backups/${encodeURIComponent(id)}/restore`, {method: 'POST', body: {}});
      lsSet(LS_DAY, '');
      applyServerDataset(r.dataset);
      closeModal('backupListOverlay');
      showToast(`'${name}' 백업으로 복원했습니다.`);
    }catch(err){ showToast('복원 실패: ' + err.message, true); }
  } else if(btn.dataset.act === 'delete'){
    if(!confirm(`'${name}' 백업을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try{ await api(`/api/backups/${encodeURIComponent(id)}`, {method: 'DELETE'}); openBackupList(); showToast('백업을 삭제했습니다.'); }
    catch(err){ showToast('삭제 실패: ' + err.message, true); }
  }
}

// 전체 데이터를 예전 HTML과 같은 형식(JSON)으로 내려받기 — 관리자 페이지에서 다시 가져올 수도 있음
function downloadAllData(){
  sessions[currentSessionIndex].state = collectState();
  const data = {
    sessions: sessions.map(s=>({label: s.label, state: s.state || cloneState(baseDefaultState), hidden: !!s.hidden})),
    currentSessionIndex, roundCount: defaultRoundCount, roundLabels: defaultRoundLabels(),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 1)], {type: 'application/json'});
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `홀덤장부_전체데이터_${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}

function askPasscode(){
  openModal('passcodeOverlay');
  setTimeout(()=>document.getElementById('passcodeInput').focus(), 50);
}
function confirmPasscode(){
  const v = document.getElementById('passcodeInput').value;
  if(!v) return;
  lsSet(LS_PASS, v);
  closeModal('passcodeOverlay');
  loadFromServer();
}


/* ===================== 여러 날짜 합산 정산 =====================
 * 선택한 날짜들의 "최종 처리금액"을 같은 이름끼리 더합니다. (계산은 calc.js의 aggregateSettlement — 서버와 같은 코드)
 * 저장하면 시트의 정산 이력 탭에 그 시점 금액으로 남고, 포함된 날짜 탭에 '정산' 배지가 표시됩니다.
 * 정산 뒤에 그 날짜의 금액이 바뀌면 '정산 후 변경'으로 바뀝니다.
 */
const SETTLE_CANCELED = '취소';
let settlements = [];
let settleSelected = new Set();
let settleNameTouched = false;
let lastSettleAgg = null;

function settleSig(runs){ return (runs || []).map(r=>`${r.id}:${r.status}`).join('|'); }
function activeRunForDay(dayId){ return settlements.find(r=>r.status !== SETTLE_CANCELED && r.dayIds.indexOf(dayId) >= 0) || null; }
function liveState(s){
  return sessions.indexOf(s) === currentSessionIndex ? collectState() : (s.state || cloneState(baseDefaultState));
}
function calcOpts(){ return {roundCount: defaultRoundCount, roundLabels: defaultRoundLabels()}; } // 날짜별 부 개수는 state['round-count']가 우선
// 날짜 탭 / 📅 목록의 "정산" 배지. 정산 뒤 금액이 바뀌면 주황색 + 안내(툴팁)
function settleStatusOf(s){
  const run = s && s.id ? activeRunForDay(s.id) : null;
  if(!run) return null;
  return {run, changed: dayChangedSinceSettle(s, run)};
}
function settleBadgeHtml(s){
  const st = settleStatusOf(s);
  if(!st) return '';
  const tip = st.changed ? `정산 후 금액이 바뀌었습니다 · ${st.run.name}` : `정산: ${st.run.name}`;
  return `<span class="settle-badge${st.changed ? ' is-changed' : ''}" title="${escapeHtml(tip)}">정산</span>`;
}
// 입력할 때마다 지금 날짜 배지만 다시 계산 (잠깐 모아서)
let settleBadgeTimer = null;
function scheduleSettleBadgeRefresh(){
  if(!settlements.length) return;
  clearTimeout(settleBadgeTimer);
  settleBadgeTimer = setTimeout(()=>{
    const s = sessions[currentSessionIndex]; if(!s) return;
    const tab = document.querySelector(`#dayTabsBar .daytab[data-idx="${currentSessionIndex}"]`); if(!tab) return;
    const old = tab.querySelector('.settle-badge');
    if(old) old.remove();
    const html = settleBadgeHtml(s);
    if(html) tab.querySelector('.daytab-label').insertAdjacentHTML('afterend', html);
  }, 400);
}
function dayChangedSinceSettle(s, run){
  const snap = run.details.filter(d=>d.dayId === s.id);
  const agg = LedgerCalc.aggregateSettlement([{id: s.id, label: s.label, state: liveState(s)}], calcOpts());
  if(agg.blocking || agg.details.length !== snap.length) return true;
  const key = d=>`${d.slot}|${d.name}|${d.amount}`;
  return snap.map(key).sort().join(',') !== agg.details.map(key).sort().join(',');
}
function isSettleOpen(){ return document.getElementById('settleOverlay').style.display === 'flex'; }
function openSettle(){
  if(syncBlockedReason === 'migration'){ showToast('기존 데이터 이전을 먼저 진행해주세요.', true); return; }
  settleSelected = new Set([...settleSelected].filter(id=>sessions.some(s=>s.id === id) && !activeRunForDay(id)));
  showSettleTab('new');
  openModal('settleOverlay');
}
function showSettleTab(t){
  document.querySelectorAll('.settle-tab').forEach(b=>b.classList.toggle('active', b.dataset.stab === t));
  document.getElementById('settleNewPane').style.display = t === 'new' ? '' : 'none';
  document.getElementById('settleHistoryPane').style.display = t === 'history' ? '' : 'none';
  if(t === 'new') renderSettleNew(); else renderSettleHistory();
}
function rerenderSettle(){
  const t = document.querySelector('.settle-tab.active');
  showSettleTab(t ? t.dataset.stab : 'new');
}
function selectedSettleDays(){
  return sessions.filter(s=>settleSelected.has(s.id)).map(s=>({id: s.id, label: s.label, state: liveState(s)}));
}
function amountTd(n, extra){
  const cls = n > 0 ? 'pos' : (n < 0 ? 'neg' : '');
  return `<td class="out ${cls} ${extra || ''}">${fmtSigned(n)}</td>`;
}
// dayCols: [{id,label}], totals: [{name,total,byDay}] — 결과(합계)가 잘 보이도록 이름 바로 옆에 둡니다
function settleTableHtml(dayCols, totals){
  let h = '<tr><th style="text-align:left;">이름</th><th class="total">합계</th>' + dayCols.map(d=>`<th>${escapeHtml(d.label)}</th>`).join('') + '</tr>';
  totals.forEach(t=>{
    h += `<tr><td class="name">${escapeHtml(t.name)}</td>` + amountTd(t.total, 'total');
    dayCols.forEach(d=>{ h += (t.byDay[d.id] !== undefined) ? amountTd(t.byDay[d.id]) : '<td class="out" style="color:var(--sub);">-</td>'; });
    h += '</tr>';
  });
  const sums = dayCols.map(d=>totals.reduce((a, t)=>a + (t.byDay[d.id] !== undefined ? t.byDay[d.id] : 0), 0));
  h += `<tr class="sum"><td class="name">합계</td><td class="out total">${fmtSigned(sums.reduce((a, b)=>a + b, 0))}</td>` + sums.map(v=>`<td class="out">${fmtSigned(v)}</td>`).join('') + '</tr>';
  return h;
}
function similarNamePairs(names){
  const pairs = [];
  const norm = (x)=>x.replace(/\s+/g, '');
  for(let i = 0; i < names.length; i++) for(let j = i + 1; j < names.length; j++){
    const a = names[i], b = names[j];
    const na = norm(a), nb = norm(b);
    if(na === nb || (Math.min(na.length, nb.length) >= 2 && (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0))) pairs.push([a, b]);
  }
  return pairs;
}
function settleIssuesHtml(agg){
  const out = [];
  const is = agg.issues;
  if(is.emptyNames.length) out.push(`<div class="issue block">이름이 비어있는 참가자가 있어 정산할 수 없습니다: ${is.emptyNames.map(x=>`'${escapeHtml(x.label)}' ${x.slot}번`).join(', ')}<br>날짜 탭에서 이름을 입력해주세요.</div>`);
  if(is.duplicateNames.length) out.push(`<div class="issue block">같은 날짜에 같은 이름이 두 번 있어 정산할 수 없습니다: ${is.duplicateNames.map(x=>`'${escapeHtml(x.label)}'의 '${escapeHtml(x.name)}'`).join(', ')}</div>`);
  if(is.unbalanced.length) out.push(`<div class="issue warn">정산 합계가 0이 아닌 날짜가 있습니다 (순위·바운티 미배정 등): ${is.unbalanced.map(x=>`'${escapeHtml(x.label)}' ${fmtSigned(x.check)}`).join(', ')}</div>`);
  const pairs = similarNamePairs(agg.totals.map(t=>t.name));
  if(pairs.length) out.push(`<div class="issue warn">비슷한 이름이 있습니다: ${pairs.map(p=>`'${escapeHtml(p[0])}' / '${escapeHtml(p[1])}'`).join(', ')}<br>지금은 서로 다른 사람으로 합산됩니다. 같은 사람이면 날짜 탭에서 이름을 똑같이 맞춰주세요.</div>`);
  if(!out.length) out.push('<div class="issue info">같은 이름끼리 각 날짜의 최종 처리금액을 더한 결과입니다.</div>');
  return out.join('');
}
function defaultSettleName(days){
  if(!days.length) return '';
  if(days.length === 1) return `${days[0].label} 정산`;
  return `${days[0].label} ~ ${days[days.length - 1].label} 정산`;
}
function renderSettleNew(){
  const list = document.getElementById('settleDayList');
  list.innerHTML = sessions.map(s=>{
    const run = activeRunForDay(s.id);
    const r = LedgerCalc.computeSettlement(liveState(s), calcOpts());
    const chips = [];
    if(s.hidden) chips.push('<span class="chip muted">숨김</span>');
    if(run) chips.push(`<span class="chip">정산 · ${escapeHtml(run.name)}</span>`);
    if(run && dayChangedSinceSettle(s, run)) chips.push('<span class="chip warn">정산 후 변경</span>');
    else if(r.grandCheck !== 0) chips.push('<span class="chip warn">확인필요</span>');
    return `<label class="settle-day${run ? ' disabled' : ''}">
      <input type="checkbox" data-id="${escapeHtml(s.id)}" ${settleSelected.has(s.id) ? 'checked' : ''} ${run ? 'disabled' : ''}>
      <span>${escapeHtml(s.label)}</span>
      <span class="meta">${chips.join('')}<span>${r.n}명</span></span>
    </label>`;
  }).join('');
  renderSettleResult();
}
function renderSettleResult(){
  const days = selectedSettleDays();
  const table = document.getElementById('settleResultTable');
  const issuesEl = document.getElementById('settleIssues');
  const nameEl = document.getElementById('settleName');
  if(!settleNameTouched) nameEl.value = defaultSettleName(days);
  if(!days.length){
    lastSettleAgg = null;
    table.innerHTML = '';
    issuesEl.innerHTML = '<div class="issue info">위에서 정산할 날짜를 선택하세요.</div>';
    document.getElementById('settleSummary').textContent = '';
  } else {
    const agg = LedgerCalc.aggregateSettlement(days, calcOpts());
    lastSettleAgg = {agg, days};
    table.innerHTML = settleTableHtml(days.map(d=>({id: d.id, label: d.label})), agg.totals);
    issuesEl.innerHTML = settleIssuesHtml(agg);
    document.getElementById('settleSummary').textContent = `${days.length}개 날짜 · ${agg.totals.length}명`;
  }
  document.getElementById('btnSettleSave').disabled = !lastSettleAgg || lastSettleAgg.agg.blocking || !syncReady;
  document.getElementById('btnSettleCsv').disabled = !lastSettleAgg;
}
function downloadCsv(filename, rows){
  const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], {type: 'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
}
function settleCsvRows(dayCols, totals){
  const rows = [['이름', ...dayCols.map(d=>d.label), '합계']];
  totals.forEach(t=>rows.push([t.name, ...dayCols.map(d=>t.byDay[d.id] !== undefined ? t.byDay[d.id] : ''), t.total]));
  const sums = dayCols.map(d=>totals.reduce((a, t)=>a + (t.byDay[d.id] !== undefined ? t.byDay[d.id] : 0), 0));
  rows.push(['합계', ...sums, sums.reduce((a, b)=>a + b, 0)]);
  return rows;
}
async function saveSettlement(){
  if(!lastSettleAgg) return;
  const {agg, days} = lastSettleAgg;
  if(agg.blocking){ showToast('이름 문제를 먼저 해결해주세요.', true); return; }
  const name = document.getElementById('settleName').value.trim();
  if(!name){ showToast('정산 이름을 입력해주세요.', true); return; }
  if(agg.issues.unbalanced.length && !confirm(`정산 합계가 0이 아닌 날짜가 있습니다:\n${agg.issues.unbalanced.map(x=>`· ${x.label} (${fmtSigned(x.check)})`).join('\n')}\n\n그래도 정산 완료로 저장할까요?`)) return;
  if(!confirm(`'${name}'\n${days.length}개 날짜, ${agg.totals.length}명의 합계를 정산 완료로 저장할까요?\n저장하면 이 날짜 탭들에 '정산' 배지가 표시됩니다.`)) return;
  if(!(await flushSave())){ showToast('저장되지 않은 변경이 있어 정산하지 못했습니다. 잠시 후 다시 시도해주세요.', true); return; }
  const agg2 = LedgerCalc.aggregateSettlement(selectedSettleDays(), calcOpts());
  const expected = {};
  agg2.totals.forEach(t=>{ expected[t.name] = t.total; });
  const btn = document.getElementById('btnSettleSave');
  btn.disabled = true;
  try{
    const r = await api('/api/settlements', {method: 'POST', body: {name, dayIds: days.map(d=>d.id), expected}});
    settlements = r.settlements;
    settleSelected.clear();
    settleNameTouched = false;
    renderDayTabs();
    showSettleTab('history');
    showToast(`'${name}' 정산을 저장했습니다.`);
  }catch(e){
    showToast('정산 저장 실패: ' + e.message, true);
    btn.disabled = false;
    if(e.code === 'ALREADY_SETTLED' || e.code === 'CHANGED') refreshIfChanged();
  }
}
function runTotals(run){
  const byName = {};
  run.details.forEach(d=>{ (byName[d.name] = byName[d.name] || {})[d.dayId] = d.amount; });
  return run.totals.map(t=>({name: t.name, total: t.total, days: t.days, byDay: byName[t.name] || {}}));
}
function runDayCols(run){
  return run.dayIds.map((id, i)=>{
    const d = run.details.find(x=>x.dayId === id);
    return {id, label: (d && d.label) || run.dayLabels[i] || id};
  });
}
function renderSettleHistory(){
  const el = document.getElementById('settleHistoryList');
  if(!settlements.length){ el.innerHTML = '<div class="empty-note">아직 정산 이력이 없습니다.</div>'; return; }
  el.innerHTML = settlements.slice().reverse().map(run=>{
    const canceled = run.status === SETTLE_CANCELED;
    const cols = runDayCols(run);
    const changed = canceled ? [] : cols.filter(c=>{ const s = sessions.find(x=>x.id === c.id); return !s || dayChangedSinceSettle(s, run); });
    const chips = [canceled ? '<span class="chip muted">취소됨</span>' : '<span class="chip">정산완료</span>'];
    if(changed.length) chips.push(`<span class="chip warn">정산 후 변경 ${changed.length}개 날짜</span>`);
    const note = changed.length ? `<div class="issue warn">정산 뒤에 금액이 바뀌었거나 삭제된 날짜: ${changed.map(c=>`'${escapeHtml(c.label)}'${sessions.some(x=>x.id === c.id) ? '' : '(삭제됨)'}`).join(', ')}<br>아래 금액은 정산 당시 금액입니다. 다시 정산하려면 이 정산을 취소한 뒤 새로 정산하세요.</div>` : '';
    return `<div class="settle-run${canceled ? ' canceled' : ''}">
      <h4>${escapeHtml(run.name)} ${chips.join('')}</h4>
      <div class="meta">${escapeHtml(formatTime(run.createdAt))} · ${cols.length}개 날짜 · ${run.totals.length}명${canceled ? ` · ${escapeHtml(formatTime(run.canceledAt))} 취소` : ''}</div>
      ${note}
      <div class="tablewrap"><table class="settle-table">${settleTableHtml(cols, runTotals(run))}</table></div>
      <div class="run-actions">
        <button type="button" class="secondary small" data-act="csv" data-id="${escapeHtml(run.id)}">⬇ CSV</button>
        ${canceled ? '' : `<button type="button" class="secondary small" data-act="cancel" data-id="${escapeHtml(run.id)}">정산 취소</button>`}
      </div>
    </div>`;
  }).join('');
}
async function settleHistoryClick(e){
  const btn = e.target.closest('[data-act]');
  if(!btn) return;
  const run = settlements.find(r=>r.id === btn.dataset.id);
  if(!run) return;
  if(btn.dataset.act === 'csv'){
    downloadCsv(`홀덤정산_합산_${run.name}.csv`, settleCsvRows(runDayCols(run), runTotals(run)));
  } else if(btn.dataset.act === 'cancel'){
    if(!syncReady){ showToast('서버와 동기화된 상태에서만 취소할 수 있습니다.', true); return; }
    if(!confirm(`'${run.name}' 정산을 취소할까요?\n이력은 '취소됨'으로 남고, 포함된 날짜들은 다시 정산할 수 있게 됩니다.`)) return;
    try{
      const r = await api(`/api/settlements/${encodeURIComponent(run.id)}/cancel`, {method: 'POST', body: {}});
      settlements = r.settlements;
      renderDayTabs();
      renderSettleHistory();
      showToast(`'${run.name}' 정산을 취소했습니다.`);
    }catch(err){ showToast('취소 실패: ' + err.message, true); }
  }
}
function initSettle(){
  document.querySelectorAll('.settle-tab').forEach(b=>b.addEventListener('click', ()=>showSettleTab(b.dataset.stab)));
  document.getElementById('settleDayList').addEventListener('change', (e)=>{
    const cb = e.target.closest('input[type=checkbox]');
    if(!cb) return;
    if(cb.checked) settleSelected.add(cb.dataset.id); else settleSelected.delete(cb.dataset.id);
    renderSettleResult();
  });
  document.getElementById('btnSettleSelectOpen').addEventListener('click', ()=>{
    sessions.forEach(s=>{ if(!s.hidden && !activeRunForDay(s.id)) settleSelected.add(s.id); });
    renderSettleNew();
  });
  document.getElementById('btnSettleSelectNone').addEventListener('click', ()=>{ settleSelected.clear(); renderSettleNew(); });
  document.getElementById('settleName').addEventListener('input', ()=>{ settleNameTouched = true; });
  document.getElementById('btnSettleSave').addEventListener('click', saveSettlement);
  document.getElementById('btnSettleCsv').addEventListener('click', ()=>{
    if(!lastSettleAgg) return;
    const name = document.getElementById('settleName').value.trim() || '정산';
    downloadCsv(`홀덤정산_합산_${name}.csv`, settleCsvRows(lastSettleAgg.days.map(d=>({id: d.id, label: d.label})), lastSettleAgg.agg.totals));
  });
  document.getElementById('settleHistoryList').addEventListener('click', settleHistoryClick);
}


/* ===================== 날짜 탭: 한 줄 스크롤 + 전체 날짜 목록 ===================== */
function setStripScroll(bar, left){
  const prev = bar.style.scrollBehavior;
  bar.style.scrollBehavior = 'auto';
  bar.scrollLeft = left;
  bar.style.scrollBehavior = prev;
}
function ensureActiveTabVisible(smooth){
  const bar = document.getElementById('dayTabsBar');
  const act = bar.querySelector('.daytab.active');
  if(!act) return;
  const pad = 36;
  let target = null;
  // 탭이 보이는 폭보다 넓으면(좁은 화면) 탭 앞부분이 보이게 맞춤
  if(act.offsetWidth + pad * 2 > bar.clientWidth) target = Math.max(0, act.offsetLeft - Math.max(0, (bar.clientWidth - act.offsetWidth) / 2));
  else if(act.offsetLeft - pad < bar.scrollLeft) target = Math.max(0, act.offsetLeft - pad);
  else if(act.offsetLeft + act.offsetWidth + pad > bar.scrollLeft + bar.clientWidth) target = act.offsetLeft + act.offsetWidth + pad - bar.clientWidth;
  if(target === null) return;
  if(smooth) bar.scrollTo({left: target, behavior: 'smooth'}); else setStripScroll(bar, target);
}
function updateStripState(){
  const bar = document.getElementById('dayTabsBar');
  const wrap = document.getElementById('dayStripWrap');
  const row = wrap.parentElement;
  const max = bar.scrollWidth - bar.clientWidth;
  const overflowing = max > 2;
  row.classList.toggle('overflowing', overflowing);
  wrap.classList.toggle('fade-left', overflowing && bar.scrollLeft > 2);
  wrap.classList.toggle('fade-right', overflowing && bar.scrollLeft < max - 2);
  document.getElementById('btnDayPrev').disabled = !(bar.scrollLeft > 2);
  document.getElementById('btnDayNext').disabled = !(bar.scrollLeft < max - 2);
}
function afterDayTabsRender(prevScroll){
  const bar = document.getElementById('dayTabsBar');
  setStripScroll(bar, prevScroll || 0);
  ensureActiveTabVisible(false);
  updateStripState();
  const n = sessions.filter(s=>!s.hidden).length;
  document.getElementById('allDaysCount').textContent = String(n);
  document.getElementById('btnAllDays').title = `전체 날짜 ${n}개${sessions.length > n ? ` (숨긴 날짜 ${sessions.length - n}개)` : ''}`;
  if(isAllDaysOpen()) renderAllDays();
}
// 탭의 ⋯ 메뉴는 스크롤 영역 밖으로 띄워서(화면 기준) 잘리지 않게 합니다.
function positionDayMenu(btn, menu){
  if(!menu) return;
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 160, h = menu.offsetHeight || 180;
  let left = Math.min(r.right - w, window.innerWidth - w - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if(top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}
// 탭 줄이 스크롤되거나 창 크기가 바뀌면 열린 ⋯ 메뉴를 버튼 위치로 따라 옮깁니다. (버튼이 안 보이게 되면 닫음)
function repositionOpenDayMenu(){
  const w = document.querySelector('.dtdropdown.open');
  if(!w) return;
  const btn = w.querySelector('[data-action="togglemenu"]');
  const bar = w.closest('.daytabs-strip');
  if(bar){
    const br = bar.getBoundingClientRect(), r = btn.getBoundingClientRect();
    if(r.right < br.left + 4 || r.left > br.right - 4){ closeAllDayMenus(); return; }
  }
  positionDayMenu(btn, w.querySelector('.dtdropdown-menu'));
}
function scrollDayStrip(dir){
  const bar = document.getElementById('dayTabsBar');
  bar.scrollBy({left: dir * Math.max(160, bar.clientWidth * 0.7), behavior: 'smooth'});
}

function isAllDaysOpen(){ return document.getElementById('allDaysOverlay').style.display === 'flex'; }
function openAllDays(){
  const q = document.getElementById('allDaysSearch');
  q.value = '';
  openModal('allDaysOverlay');
  renderAllDays();
  const cur = document.querySelector('#allDaysList .day-list-item.current');
  if(cur) cur.scrollIntoView({block: 'center'});
  if(window.matchMedia('(hover: hover)').matches) q.focus();
}
function renderAllDays(){
  const norm = (x)=>String(x).toLowerCase().replace(/\s+/g, '');
  const q = norm(document.getElementById('allDaysSearch').value);
  const match = (s)=> !q || norm(s.label).indexOf(q) >= 0;
  const people = (s)=>{ const v = parseInt((s === sessions[currentSessionIndex] ? collectState() : (s.state || {}))['participantCount'], 10); return v ? `${v}명` : ''; };
  const visible = sessions.map((s, idx)=>({s, idx})).filter(x=>!x.s.hidden && match(x.s));
  const hidden = sessions.map((s, idx)=>({s, idx})).filter(x=>x.s.hidden && match(x.s));
  let h = visible.map(({s, idx})=>`<button type="button" class="day-list-item${idx === currentSessionIndex ? ' current' : ''}" data-idx="${idx}">
      <span>${escapeHtml(s.label)}${settleBadgeHtml(s)}</span><span class="meta">${idx === currentSessionIndex ? '보는 중 · ' : ''}${people(s)}</span></button>`).join('');
  if(hidden.length){
    h += `<div class="day-list-section">숨긴 날짜 (${hidden.length})</div>` + hidden.map(({s, idx})=>`<div class="day-list-row">
      <button type="button" class="day-list-item" data-idx="${idx}" data-hidden="1" style="opacity:.65;"><span>${escapeHtml(s.label)}${settleBadgeHtml(s)}</span><span class="meta">${people(s)}</span></button>
      <button type="button" class="secondary small" data-unhide="${idx}">숨김 해제</button></div>`).join('');
  }
  if(!visible.length && !hidden.length) h = '<div class="empty-note">검색 결과가 없습니다.</div>';
  document.getElementById('allDaysList').innerHTML = h;
}
function allDaysClick(e){
  const un = e.target.closest('[data-unhide]');
  if(un){ unhideDay(parseInt(un.dataset.unhide, 10)); renderAllDays(); return; }
  const item = e.target.closest('.day-list-item');
  if(!item) return;
  const idx = parseInt(item.dataset.idx, 10);
  if(item.dataset.hidden){
    if(!confirm(`'${sessions[idx].label}'은(는) 숨긴 날짜입니다. 숨김을 해제하고 열까요?`)) return;
    unhideDay(idx);
  }
  closeModal('allDaysOverlay');
  switchToDay(idx);
  ensureActiveTabVisible(true);
}
function initDayStrip(){
  const bar = document.getElementById('dayTabsBar');
  bar.addEventListener('scroll', ()=>{ updateStripState(); repositionOpenDayMenu(); }, {passive: true});
  document.getElementById('hiddenDayTabsBar').addEventListener('scroll', repositionOpenDayMenu, {passive: true});
  window.addEventListener('resize', ()=>{ updateStripState(); repositionOpenDayMenu(); });
  window.addEventListener('scroll', repositionOpenDayMenu, {passive: true});
  document.getElementById('btnDayPrev').addEventListener('click', ()=>scrollDayStrip(-1));
  document.getElementById('btnDayNext').addEventListener('click', ()=>scrollDayStrip(1));
  document.getElementById('btnAllDays').addEventListener('click', (e)=>{ e.stopPropagation(); openAllDays(); });
  document.getElementById('allDaysSearch').addEventListener('input', renderAllDays);
  document.getElementById('allDaysSearch').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ const first = document.querySelector('#allDaysList .day-list-item:not([data-hidden])'); if(first) first.click(); }
  });
  document.getElementById('allDaysList').addEventListener('click', allDaysClick);
}

/* ===================== 시작 ===================== */
function init(){
  applyTheme(lsGet(LS_THEME) || 'light');
  buildParticipantCountSelect();
  buildParticipantTable();
  buildRankRatioTable();
  ensureRoundsBuilt(3);
  builtRoundSig = roundSig();
  buildFinalTable();

  // 장부 영역(#appRoot) 안의 입력만 "날짜 데이터 변경"으로 봅니다 (팝업의 입력칸은 제외)
  const onEdit = (e)=>{
    if(!e.target.closest('#appRoot')) return;
    recalcAll();
    markDayDirty(sessions[currentSessionIndex]);
  };
  document.body.addEventListener('input', onEdit);
  document.body.addEventListener('change', onEdit);

  document.getElementById('btnMoreMenu').addEventListener('click', (e)=>{ e.stopPropagation(); toggleMoreMenu(); });
  document.getElementById('miSettleGroup').addEventListener('click', (e)=>{ e.stopPropagation(); setSettleGroupOpen(document.getElementById('miSettleSub').hidden); });
  document.getElementById('miSettle').addEventListener('click', (e)=>{ e.stopPropagation(); closeMoreMenu(); openSettle(); });
  document.getElementById('miThemeToggle').addEventListener('click', (e)=>{ e.stopPropagation(); toggleTheme(); closeMoreMenu(); });
  document.getElementById('miExport').addEventListener('click', (e)=>{ e.stopPropagation(); exportCSV(); closeMoreMenu(); });
  document.getElementById('miBackupCreate').addEventListener('click', (e)=>{ e.stopPropagation(); closeMoreMenu(); openBackupCreate(); });
  document.getElementById('miBackupList').addEventListener('click', (e)=>{ e.stopPropagation(); closeMoreMenu(); openBackupList(); });
  document.getElementById('miDownloadData').addEventListener('click', (e)=>{ e.stopPropagation(); closeMoreMenu(); downloadAllData(); });
  document.getElementById('btnDayMoreMenu').addEventListener('click', (e)=>{ e.stopPropagation(); toggleDayMoreMenu(); });
  document.getElementById('miAddDay').addEventListener('click', (e)=>{ e.stopPropagation(); addDay(); closeDayMoreMenu(); });
  document.getElementById('miToggleHidden').addEventListener('click', (e)=>{ e.stopPropagation(); hiddenTabsVisible = !hiddenTabsVisible; renderDayTabs(); closeDayMoreMenu(); });
  document.addEventListener('click', (e)=>{
    if(!e.target.closest('.dtdropdown')) closeAllDayMenus();
    if(!e.target.closest('#moreMenuWrap')) closeMoreMenu();
    if(!e.target.closest('#dayMoreMenuWrap')) closeDayMoreMenu();
  });
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click', ()=>closeModal(b.dataset.close)));
  initSettle();
  initDayStrip();
  ['backupCreateOverlay', 'backupListOverlay', 'settleOverlay', 'allDaysOverlay'].forEach(id=>{
    document.getElementById(id).addEventListener('click', (e)=>{ if(e.target.id === id) closeModal(id); });
  });
  document.getElementById('btnBackupCreateConfirm').addEventListener('click', confirmBackupCreate);
  document.getElementById('backupName').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') confirmBackupCreate(); });
  document.getElementById('backupList').addEventListener('click', backupListClick);
  document.getElementById('btnPasscodeConfirm').addEventListener('click', confirmPasscode);
  document.getElementById('passcodeInput').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') confirmPasscode(); });
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape'){ closeModal('allDaysOverlay'); closeModal('settleOverlay'); closeModal('backupCreateOverlay'); closeModal('backupListOverlay'); closeMoreMenu(); closeDayMoreMenu(); closeAllDayMenus(); }
  });
  document.getElementById('roundTabsBar').addEventListener('click', roundTabsClickHandler);
  document.getElementById('dayTabsBar').addEventListener('click', dayTabsClickHandler);
  document.getElementById('hiddenDayTabsBar').addEventListener('click', dayTabsClickHandler);
  const dayTabsBarEl = document.getElementById('dayTabsBar');
  dayTabsBarEl.addEventListener('dragstart', dayTabsDragStart);
  dayTabsBarEl.addEventListener('dragover', dayTabsDragOver);
  dayTabsBarEl.addEventListener('dragleave', dayTabsDragLeave);
  dayTabsBarEl.addEventListener('drop', dayTabsDrop);
  dayTabsBarEl.addEventListener('dragend', dayTabsDragEnd);

  recalcAll();
  baseDefaultState = collectState();

  // 불러오기 전 임시 화면 (저장 대상 아님)
  sessions = [{id: newDayId(), label: defaultDayLabel(), state: null, hidden: false, version: 0, editSeq: 0, savedSeq: 0}];
  currentSessionIndex = 0;
  renderDayTabs();
  switchRound(1);

  window.addEventListener('beforeunload', (e)=>{
    if(hasUnsaved()){ e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'hidden'){ if(syncReady && hasUnsaved()) doSave(); }
    else refreshIfChanged();
  });
  // 화면을 켜둔 채로 있어도 30초마다 다른 기기의 변경을 확인 (이 기기에 저장 안 된 변경이 있으면 건너뜀)
  setInterval(()=>{ if(document.visibilityState === 'visible') refreshIfChanged(); }, 30000);

  loadFromServer();
}
document.addEventListener('DOMContentLoaded', init);
