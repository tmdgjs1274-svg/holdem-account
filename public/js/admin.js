'use strict';
(function(){
  const $ = (id)=>document.getElementById(id);
  const esc = (s)=>String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n)=>Math.round(Number(n)||0).toLocaleString('ko-KR');
  try{ $('adminPass').value = sessionStorage.getItem('holdem-admin') || ''; }catch(e){}
  let lastPreviewOk = false;

  async function call(path, body){
    const pass = $('adminPass').value;
    try{ sessionStorage.setItem('holdem-admin', pass); }catch(e){}
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'Content-Type':'application/json', 'x-admin-passcode': pass},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = {}; try{ json = await res.json(); }catch(e){}
    if(!res.ok){ const err = new Error(json.message || `오류 (${res.status})`); err.data = json; throw err; }
    return json;
  }
  const diffBox = (diffs)=> diffs && diffs.length ? `<div class="diffs">${diffs.map(esc).join('\n')}</div>` : '';

  $('btnStatus').addEventListener('click', async ()=>{
    const out = $('statusResult');
    out.innerHTML = '확인 중…';
    try{
      const r = await call('/api/admin/status');
      const tabs = (r.sheet.tabs || []).map(t=>t.title).join(', ');
      out.innerHTML = `
        <div class="${r.roundtripOk && !r.readOnly ? 'okbox' : 'badbox'}">
          구글 시트 연결 정상 · "${esc(r.sheet.title)}"<br>
          새 구조 데이터: ${r.days}개 날짜 / ${fmt(r.values)}개 값 · 상태: ${esc(r.status)}
          ${r.readOnly ? `<br>⚠ 저장 잠김: ${esc(r.readOnly.reason)}` : ''}
        </div>
        <div class="hint">탭 목록: ${esc(tabs)}</div>
        ${r.sheet.serviceAccountEmail ? `<div class="hint">서비스 계정: ${esc(r.sheet.serviceAccountEmail)}</div>` : ''}
        ${r.warnings && r.warnings.length ? `<div class="hint">경고</div>${diffBox(r.warnings)}` : ''}
        ${r.diffs && r.diffs.length ? diffBox(r.diffs) : ''}
        ${r.readOnly ? '<button id="btnUnlock" class="secondary" style="margin-top:8px;">원인 확인 후 저장 잠금 해제</button>' : ''}`;
      const u = $('btnUnlock');
      if(u) u.addEventListener('click', async ()=>{ if(!confirm('원인을 확인하셨나요? 저장 잠금을 해제합니다.')) return; await call('/api/admin/unlock', {}); $('btnStatus').click(); });
    }catch(e){
      out.innerHTML = `<div class="badbox">${esc(e.message)}</div>`;
    }
  });

  $('btnPreview').addEventListener('click', async ()=>{
    const out = $('previewResult');
    out.innerHTML = '기존 데이터를 읽고 검증하는 중…';
    $('btnApply').disabled = true; lastPreviewOk = false;
    try{
      const r = await call('/api/admin/migrate/preview', {sourceJson: $('sourceJson').value});
      const rows = r.days.map((d, i)=>`<tr><td>${i+1}</td><td style="text-align:left;">${esc(d.label)}${d.hidden ? ' (숨김)' : ''}</td><td>${d.participants}명</td><td>${d.values}</td><td>${fmt(d.totalBuyin)}</td><td>${d.check === 0 ? '0 ✓' : fmt(d.check)}</td></tr>`).join('');
      const writes = Object.entries(r.rowsToWrite).map(([t, n])=>`${t} ${n}행`).join(' · ');
      out.innerHTML = `
        <div class="hint">원본: ${esc(r.source.from)}${r.source.savedAt ? ` (저장시각 ${esc(r.source.savedAt)})` : ''} · ${fmt(r.source.chars)}자</div>
        <div class="tablewrap"><table>
          <tr><th>#</th><th>날짜</th><th>참가자</th><th>값 개수</th><th>총 바이인</th><th>정산 합계</th></tr>${rows}
        </table></div>
        <div class="hint">새 탭에 쓰일 행: ${esc(writes)}</div>
        ${r.ok
          ? `<div class="okbox">검증 통과: ${r.days.length}개 날짜, ${fmt(r.checkedValues)}개 값이 새 구조에서 1글자도 다르지 않게 복원됩니다.</div>`
          : `<div class="badbox">검증 실패: 차이가 있어 이전할 수 없습니다.</div>${diffBox(r.diffs)}`}
        ${r.alreadyMigrated ? '<div class="badbox" style="margin-top:8px;">새 구조에 이미 데이터가 있어 이전할 수 없습니다. (덮어쓰기 방지)</div>' : ''}`;
      lastPreviewOk = r.ok && !r.alreadyMigrated;
      $('btnApply').disabled = !lastPreviewOk;
    }catch(e){
      out.innerHTML = `<div class="badbox">${esc(e.message)}</div>${diffBox(e.data && e.data.diffs)}`;
    }
  });

  $('btnApply').addEventListener('click', async ()=>{
    if(!lastPreviewOk) return;
    if(!confirm('새 구조로 이전을 실행할까요?\n기존 latest/history 탭은 그대로 남고, 원본 JSON은 backups 탭에도 따로 저장됩니다.')) return;
    const out = $('applyResult');
    out.innerHTML = '이전 중… (쓰기 → 다시 읽기 → 원본과 비교)';
    $('btnApply').disabled = true;
    try{
      const r = await call('/api/admin/migrate/apply', {confirm: true, sourceJson: $('sourceJson').value});
      out.innerHTML = `<div class="okbox">이전 완료 · ${r.days}개 날짜, ${fmt(r.checkedValues)}개 값을 시트에 쓴 뒤 다시 읽어 원본과 비교했고 모두 일치합니다.</div>
        <div class="hint">원본 JSON 백업 ID: ${esc(r.backupId)} (backups 탭)</div>
        <div style="margin-top:10px;"><a href="/"><button>장부 열기</button></a></div>`;
    }catch(e){
      out.innerHTML = `<div class="badbox">${esc(e.message)}</div>${diffBox(e.data && e.data.diffs)}`;
    }
  });
})();
