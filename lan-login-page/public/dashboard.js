(function(){
  const $ = s => document.querySelector(s);
  const state = { isAdmin:false, logs:{ bookmark:null, prevStack:[] } };

  async function apiFetch(path, opts = {}) {
    const url = path.startsWith('/') ? path : `/${path}`;
    return fetch(url, { credentials: 'same-origin', ...opts });
  }

  const fmtBytes = (bytes) => {
    const b = Number(bytes||0);
    if (!isFinite(b)) return '—';
    if (b < 1024) return `${b} B`;
    const u = ['KB','MB','GB','TB']; let i=-1; let n=b;
    do{ n/=1024; i++; }while(n>=1024 && i<u.length-1);
    return `${n.toFixed(n<10?1:0)} ${u[i]}`;
  };
  const fmtDateTime = (iso) => {
    if(!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  };
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const showDetailsError = (msg) => { $('#detailsBody').innerHTML = row('Database details', `<span style="color:#ffb4b4">${msg}</span>`); };

  async function loadSummary(){
    let r, j; try { r = await apiFetch('/api/summary'); j = await r.json(); } catch { j = {}; }
    if(!r?.ok || !j?.ok) return;
    $('#dbName').textContent = j.db;
    $('#sizeChip').textContent = `Size: ${fmtBytes(j.sizeBytes)}`;
    $('#docsChip').textContent = `# Docs: ${j.docCount}`;
    $('#usersChip').textContent = `Users: ${j.usersCount ?? '—'}`;
    $('#onlineChip').textContent = `Online: ${j.online ? 'Yes' : 'No'}`;
    $('#activeChip').textContent = `Active: ${j.active ? 'Yes' : 'No'}`;
  }

  async function loadDbDetails(){
    let r, j; try { r = await apiFetch('/api/db-details'); j = await r.json(); } catch { j = {}; }
    if(!r?.ok || !j?.ok){ showDetailsError(r?.status===404?'API not found':'HTTP '+(r?.status||'error')); return; }
    const d = j.details || {};
    const rows = [];
    rows.push(row('Name', j.db));
    rows.push(row('Partitioned', d.props?.partitioned ? 'Yes' : 'No'));
    rows.push(row('Shards (q)', d.cluster?.q ?? '—'));
    rows.push(row('Replicas (n)', d.cluster?.n ?? '—'));
    rows.push(row('Write quorum (w)', d.cluster?.w ?? '—'));
    rows.push(row('Read quorum (r)', d.cluster?.r ?? '—'));
    rows.push(row('Update seq', d.update_seq ?? '—'));
    rows.push(row('Purge seq', d.purge_seq ?? '—'));
    rows.push(row('Documents', `${d.doc_count ?? 0} (deleted: ${d.doc_del_count ?? 0})`));
    rows.push(row('Size (file)', fmtBytes(d.sizes?.file)));
    rows.push(row('Size (active)', fmtBytes(d.sizes?.active)));
    rows.push(row('Size (external)', fmtBytes(d.sizes?.external)));
    rows.push(row('Compaction running', d.compact_running ? 'Yes' : 'No'));
    if (d.security) {
      const a = d.security.admins || {names:[], roles:[]};
      const m = d.security.members || {names:[], roles:[]};
      rows.push(row('Security / Admins', `names: [${(a.names||[]).join(', ')}], roles: [${(a.roles||[]).join(', ')}]`));
      rows.push(row('Security / Members', `names: [${(m.names||[]).join(', ')}], roles: [${(m.roles||[]).join(', ')}]`));
    } else rows.push(row('Security', '— (requires admin creds)'));
    $('#detailsBody').innerHTML = rows.join('');
  }

  async function me(){ try{ const r=await apiFetch('/me'); const j=await r.json(); return j.user||{}; }catch{ return {}; } }

  // Users
  async function loadUsers(){
    const r = await apiFetch('/api/users');
    if(r.status===403){ $('#adminTools').style.display='none'; $('#usersGrid').style.display='none'; return; }
    let j={}; try{ j=await r.json(); }catch{}
    if(!r.ok || !j.ok){ $('#adminTools').style.display='none'; $('#usersGrid').style.display='none'; return; }
    $('#adminTools').style.display='flex'; $('#usersGrid').style.display='block';
    const body = $('#usersBody'); body.innerHTML='';
    j.rows.sort((a,b)=>a.name.localeCompare(b.name)).forEach(u=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${u.name}</td>
        <td>${u.fullName||'—'}</td>
        <td>${u.email||'—'}</td>
        <td>${(u.roles||[]).join(', ')}</td>
        <td>
          <button class="btn-ghost" data-edit="${u.name}">Edit</button>
          <button class="btn-ghost" data-del="${u.name}">Delete</button>
        </td>`;
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-del]').forEach(b=>{
      b.addEventListener('click', async ()=>{
        const name = b.getAttribute('data-del');
        if(!confirm(`Διαγραφή χρήστη "${name}" ;`)) return;
        const del = await apiFetch(`/api/users/${encodeURIComponent(name)}`, { method:'DELETE' });
        if(del.ok) loadUsers(); else alert('Αποτυχία διαγραφής.');
      });
    });
    body.querySelectorAll('[data-edit]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const name = b.getAttribute('data-edit');
        const row = j.rows.find(x=>x.name===name) || { name, roles:[] };
        openUserDlg('edit', row);
      });
    });
  }

  // User dialog (add/edit)
  const uDlg = document.getElementById('userDlg');
  function openUserDlg(mode, data){
    $('#dlgMsg').textContent='';
    $('#dlgTitle').textContent = mode==='add' ? 'Add user' : `Edit user — ${data.name}`;
    const fUser = $('#fUser'), fPass = $('#fPass'), fPass2 = $('#fPass2'),
          fFull = $('#fFullName'), fEmail = $('#fEmail'), fDept = $('#fDept'), fPhone = $('#fPhone'),
          fRoles = $('#fRoles');
    fUser.disabled = mode==='edit';
    fUser.value = data.name || '';
    fPass.value=''; fPass2.value='';
    fFull.value = data.fullName || '';
    fEmail.value = data.email || '';
    fDept.value = data.department || '';
    fPhone.value = data.phone || '';
    fRoles.value = (data.roles||[]).join(', ');
    uDlg.returnValue=''; uDlg.showModal();

    $('#dlgOk').onclick = async (e)=>{
      e.preventDefault();
      if(fPass.value !== fPass2.value){ $('#dlgMsg').textContent='Passwords do not match.'; return; }
      if(mode==='add'){
        const payload = { name:fUser.value, password:fPass.value, roles:fRoles.value,
          fullName:fFull.value, email:fEmail.value, department:fDept.value, phone:fPhone.value };
        const res=await apiFetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        if(res.ok){ uDlg.close('ok'); loadUsers(); } else { $('#dlgMsg').textContent='Create failed.'; }
      } else {
        const payload = { roles:fRoles.value, fullName:fFull.value, email:fEmail.value, department:fDept.value, phone:fPhone.value };
        if(fPass.value) payload.password = fPass.value;
        const res=await apiFetch(`/api/users/${encodeURIComponent(fUser.value)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        if(res.ok){ uDlg.close('ok'); loadUsers(); } else { $('#dlgMsg').textContent='Update failed.'; }
      }
    };
  }
  $('#btnAdd')?.addEventListener('click', ()=>openUserDlg('add', {}));
  $('#btnRefresh')?.addEventListener('click', ()=>{ loadSummary(); loadDbDetails(); loadUsers(); loadTypesAdmin(); });

  // Event Types admin
  async function loadTypesAdmin(){
    const r = await apiFetch('/api/admin/event-types');
    if(r.status===403){ $('#typesTools').style.display='none'; $('#typesGrid').style.display='none'; return; }
    let j={}; try{ j=await r.json(); }catch{}
    if(!r.ok || !j.ok){ $('#typesTools').style.display='none'; $('#typesGrid').style.display='none'; return; }
    $('#typesTools').style.display='flex'; $('#typesGrid').style.display='block';
    const body = $('#typesBody'); body.innerHTML='';
    j.rows.forEach(t=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${t.code}</td>
        <td>${t.name}</td>
        <td>${t.active ? 'Yes' : 'No'}</td>
        <td>
          <button class="btn-ghost" data-tedit="${t.code}">Edit</button>
          <button class="btn-ghost" data-tdel="${t.code}">Delete</button>
        </td>`;
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-tdel]').forEach(b=>{
      b.addEventListener('click', async ()=>{
        const code = b.getAttribute('data-tdel');
        if(!confirm(`Delete type "${code}" ;`)) return;
        const del = await apiFetch(`/api/admin/event-types/${encodeURIComponent(code)}`, { method:'DELETE' });
        if(del.ok) loadTypesAdmin(); else alert('Delete failed.');
      });
    });
    body.querySelectorAll('[data-tedit]').forEach(b=>{
      b.addEventListener('click', ()=>{
        const code = b.getAttribute('data-tedit');
        const row = j.rows.find(x=>x.code===code) || { code, name: code, active:true };
        openTypeDlg('edit', row);
      });
    });
  }
  $('#btnTypesRefresh')?.addEventListener('click', ()=> loadTypesAdmin());
  $('#btnTypeAdd')?.addEventListener('click', ()=> openTypeDlg('add', {}));

  // Event Type dialog
  const tDlg = $('#typeDlg');
  function openTypeDlg(mode, data){
    $('#typeDlgMsg').textContent='';
    $('#typeDlgTitle').textContent = mode==='add' ? 'Add type' : `Edit type — ${data.code}`;
    const tCode = $('#tCode'), tName = $('#tName'), tActive = $('#tActive');
    tCode.disabled = mode==='edit';
    tCode.value = data.code || '';
    tName.value = data.name || '';
    tActive.checked = (data.active !== false);
    tDlg.returnValue=''; tDlg.showModal();

    $('#typeDlgOk').onclick = async (e)=>{
      e.preventDefault();
      if(!tCode.value || !/^[a-z0-9._-]+$/i.test(tCode.value)){ $('#typeDlgMsg').textContent='Invalid code.'; return; }
      if(!tName.value){ $('#typeDlgMsg').textContent='Name required.'; return; }
      if(mode==='add'){
        const res = await apiFetch('/api/admin/event-types',{method:'POST',headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ code: tCode.value.trim(), name: tName.value.trim(), active: tActive.checked })});
        if(res.ok){ tDlg.close('ok'); loadTypesAdmin(); } else { $('#typeDlgMsg').textContent='Create failed.'; }
      } else {
        const res = await apiFetch(`/api/admin/event-types/${encodeURIComponent(tCode.value.trim())}`,{method:'PATCH',headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ name: tName.value.trim(), active: tActive.checked })});
        if(res.ok){ tDlg.close('ok'); loadTypesAdmin(); } else { $('#typeDlgMsg').textContent='Update failed.'; }
      }
    };
  }

  // Logs
  async function loadEventTypesForFilter(){
    const sel = $('#logType'); if (!sel) return;
    try{
      const r = await apiFetch('/api/event-types'); const j = await r.json();
      sel.innerHTML = `<option value="">All types</option>` + (j.rows||[]).map(x=>`<option value="${x.code}">${x.name}</option>`).join('');
    }catch{ sel.innerHTML = `<option value="">All types</option>`; }
  }
  async function loadLogs({ reset=false, direction='next' } = {}){
    const body = $('#logsBody'); const btnPrev = $('#logPrev'); const btnNext = $('#logNext');
    if (!body) return;
    const params = new URLSearchParams();
    const type = ($('#logType')?.value || '').trim(); if (type) params.set('type', type);
    const user = ($('#logUser')?.value || '').trim(); if (user) params.set('createdBy', user);
    params.set('limit','25');

    if (reset) { state.logs.bookmark = null; state.logs.prevStack = []; btnPrev && (btnPrev.disabled = true); }
    else if (direction === 'prev') {
      if (state.logs.prevStack.length > 0) state.logs.bookmark = state.logs.prevStack.pop(); else btnPrev && (btnPrev.disabled = true);
    } else if (direction === 'next') {
      if (state.logs.bookmark) state.logs.prevStack.push(state.logs.bookmark);
    }
    if (state.logs.bookmark) params.set('bookmark', state.logs.bookmark);

    let r, j; try { r = await apiFetch(`/api/events?${params.toString()}`); j = await r.json(); } catch { j = {}; }
    if(!r?.ok || !j?.ok){
      body.innerHTML = `<tr><td colspan="4" style="color:#ffb4b4">Failed to load logs (HTTP ${r?.status || 'error'})</td></tr>`;
      return;
    }
    state.logs.bookmark = j.bookmark || null;
    btnPrev && (btnPrev.disabled = state.logs.prevStack.length === 0);
    btnNext && (btnNext.disabled = !state.logs.bookmark || (j.rows||[]).length === 0);

    if (!Array.isArray(j.rows) || j.rows.length === 0) { body.innerHTML = `<tr><td colspan="4" class="muted">No results.</td></tr>`; return; }
    body.innerHTML = j.rows.map(ev=>{
      const qr = String(ev.qrData || ''), short = qr.length>64 ? (qr.slice(0,64)+'…') : qr;
      return `<tr><td>${fmtDateTime(ev.ts)}</td><td>${ev.type||'—'}</td><td title="${qr.replace(/"/g,'&quot;')}">${short}</td><td>${ev.createdBy||'—'}</td></tr>`;
    }).join('');
  }
  $('#logRefresh')?.addEventListener('click', ()=> loadLogs({ reset:true }));
  $('#logType')?.addEventListener('change', ()=> loadLogs({ reset:true }));
  $('#logUser')?.addEventListener('change', ()=> loadLogs({ reset:true }));
  $('#logPrev')?.addEventListener('click', ()=> loadLogs({ direction:'prev' }));
  $('#logNext')?.addEventListener('click', ()=> loadLogs({ direction:'next' }));

  // QR generator (admin)
  async function qrInitVisibility(isAdmin){ const sec = $('#qrSection'); if (sec) sec.style.display = isAdmin ? 'block' : 'none'; }
  async function qrBind(){
    const btnGen = $('#qr_generate'), btnDl  = $('#qr_download'), btnPr  = $('#qr_print'), msg = $('#qr_msg');
    const img = $('#qr_preview'), payloadPre = $('#qr_payload');
    if (!btnGen) return;
    let last = { dataUrl: '', filename: '', payload: null };

    btnGen.addEventListener('click', async ()=>{
      msg.textContent=''; img.style.display='none'; payloadPre.textContent=''; btnDl.disabled = true; btnPr.disabled = true;
      const body = {
        username:   String($('#qr_username').value||'').trim(),
        fullName:   String($('#qr_fullname').value||'').trim(),
        employeeId: String($('#qr_employeeId').value||'').trim(),
        department: String($('#qr_department').value||'').trim(),
        phone:      String($('#qr_phone').value||'').trim()
      };
      if(!body.username || !body.employeeId){ msg.textContent='username and employee id are required.'; return; }
      try{
        const r = await apiFetch('/api/admin/qr',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const j = await r.json().catch(()=>({}));
        if(!r.ok || !j.ok){ msg.textContent=j.message||`Failed (HTTP ${r.status})`; return; }
        last = { dataUrl:j.dataUrl, filename:j.filename, payload:j.payload };
        img.src = j.dataUrl; img.style.display='block';
        payloadPre.textContent = JSON.stringify(j.payload, null, 2);
        btnDl.disabled=false; btnPr.disabled=false;
      }catch{ msg.textContent='Error generating QR.'; }
    });

    btnDl?.addEventListener('click', ()=>{
      if(!last.dataUrl) return;
      const a = document.createElement('a'); a.href = last.dataUrl; a.download = last.filename || 'qr.png';
      document.body.appendChild(a); a.click(); a.remove();
    });
    btnPr?.addEventListener('click', ()=>{
      if(!last.dataUrl) return;
      const w = window.open('', '_blank', 'width=600,height=800');
      w.document.write(`<!doctype html><title>Print QR</title>
        <style>body{font-family:system-ui,Segoe UI,Roboto,Arial;padding:20px}.box{display:grid;justify-items:center;gap:10px}</style>
        <div class="box"><img src="${last.dataUrl}" style="max-width:420px"/><div>${(last.payload?.n||'')} (${(last.payload?.uid||'')}) — ${last.payload?.eid||''}</div></div>
        <script>window.onload=()=>setTimeout(()=>window.print(),100);</script>`);
      w.document.close();
    });
  }

  // Boot
  (async ()=>{
    const u = await me();
    state.isAdmin = (u.roles||[]).includes('app:admin');
    await loadSummary();
    await loadDbDetails();
    if(state.isAdmin){ await loadUsers(); await loadTypesAdmin(); }
    await loadEventTypesForFilter();
    await loadLogs({ reset:true });
    await qrInitVisibility(state.isAdmin);
    await qrBind();
  })();
})();