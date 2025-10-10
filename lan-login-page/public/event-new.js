(() => {
  const $ = s => document.querySelector(s);
  const evtSel = $('#evt');
  const msg = $('#msg');
  const video = $('#video');
  const startBtn = $('#startBtn');
  const stopBtn = $('#stopBtn');
  const manual = $('#manual');
  const saveManual = $('#saveManual');
  const success = $('#success');
  const succText = $('#succText');
  const againBtn = $('#againBtn');

  let stream = null;
  let scanning = false;
  let raf = 0;

  // Offscreen canvas (why: process frames for jsQR)
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  async function loadEventTypes(){
    const r = await fetch('/api/event-types');
    const j = await r.json().catch(()=>({}));
    if(!r.ok || !j.ok || !j.rows?.length){
      evtSel.innerHTML = `<option value="">—</option>`;
      evtSel.disabled = true;
      msg.textContent = 'Δεν βρέθηκαν διαθέσιμοι τύποι συμβάντων.';
      return;
    }
    evtSel.disabled = false;
    evtSel.innerHTML = j.rows.map(x => `<option value="${x.code}">${x.name}</option>`).join('');
  }

  function showSuccess(type, qr){
    succText.textContent = `Τύπος: ${type} • QR: ${qr.slice(0,48)}${qr.length>48?'…':''}`;
    success.style.display = 'grid';
  }

  async function saveEvent(type, qr){
    msg.textContent = '';
    const r = await fetch('/api/events', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type, qr })
    });
    const j = await r.json().catch(()=>({}));
    if(r.ok && j.ok){
      stopScan();
      showSuccess(type, qr);
    } else {
      msg.textContent = j.message || 'Αποτυχία καταχώρισης.';
    }
  }

  async function startScan(){
    if(!evtSel.value){ msg.textContent='Επιλέξτε τύπο συμβάντος.'; return; }
    msg.textContent='';
    try{
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = stream;
      await video.play();
      scanning = true;
      startBtn.disabled = true; stopBtn.disabled = false;

      let last = 0;
      const SCAN_MS = 150; // why: balance CPU and responsiveness

      const tick = (t) => {
        if(!scanning) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          const vw = video.videoWidth|0, vh = video.videoHeight|0;
          if (vw && vh) {
            // Fit processing size to ~720p for speed
            const targetW = Math.min(1280, vw);
            const scale = targetW / vw;
            const w = (vw * scale)|0, h = (vh * scale)|0;
            if (canvas.width !== w || canvas.height !== h) {
              canvas.width = w; canvas.height = h;
            }
            ctx.drawImage(video, 0, 0, w, h);
            if (t - last >= SCAN_MS) {
              last = t;
              try {
                const imageData = ctx.getImageData(0, 0, w, h);
                // @ts-ignore global jsQR from /lib/jsqr.js
                const code = window.jsQR && jsQR(imageData.data, w, h, { inversionAttempts: 'dontInvert' });
                if (code && code.data) {
                  saveEvent(evtSel.value, String(code.data));
                  return; // will stop on success
                }
              } catch(_) { /* ignore */ }
            }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

    }catch(e){
      msg.textContent = 'Αδυναμία πρόσβασης στην κάμερα.';
    }
  }

  function stopScan(){
    scanning = false;
    cancelAnimationFrame(raf);
    if(video) { video.pause(); video.srcObject = null; }
    if(stream){
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    startBtn.disabled = false; stopBtn.disabled = true;
  }

  startBtn.addEventListener('click', startScan);
  stopBtn.addEventListener('click', stopScan);
  saveManual.addEventListener('click', async ()=>{
    if(!evtSel.value){ msg.textContent='Επιλέξτε τύπο συμβάντος.'; return; }
    const val = (manual.value || '').trim();
    if(!val){ msg.textContent='Εισάγετε QR δεδομένα.'; return; }
    await saveEvent(evtSel.value, val);
  });
  againBtn.addEventListener('click', ()=>{
    success.style.display='none';
    manual.value='';
    startScan();
  });

  // Guard: ensure jsQR is present
  window.addEventListener('load', ()=>{
    if(!window.jsQR){
      msg.textContent = 'Το jsQR δεν βρέθηκε. Εκτελέστε: npm run get:jsqr';
      startBtn.disabled = true;
    }
  });

  loadEventTypes();
})();
