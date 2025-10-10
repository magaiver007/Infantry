const form = document.getElementById('loginForm');
const msg = document.getElementById('msg');
const btn = document.getElementById('submitBtn');
form.addEventListener('submit', async (e)=>{
  e.preventDefault(); msg.textContent=''; btn.disabled=true;
  try{
    const res = await fetch('/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const json = await res.json();
    if(!res.ok || !json.ok){ msg.textContent=json.message||'Σφάλμα.'; btn.disabled=false; return; }
    location.assign(json.redirect||'/dashboard');
  }catch{
    msg.textContent='Πρόβλημα σύνδεσης με τον διακομιστή.'; btn.disabled=false;
  }
});