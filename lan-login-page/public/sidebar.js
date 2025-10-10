(function(){
  async function injectSidebar() {
    const host = document.getElementById('sidebar');
    if (!host) return;
    try{
      const res = await fetch('/partials/sidebar.html', { credentials:'same-origin' });
      const html = await res.text();
      host.innerHTML = html;

      // Highlight active link by pathname
      const path = location.pathname.replace(/\/+$/,'') || '/';
      host.querySelectorAll('.item[href]').forEach(a=>{
        const href = a.getAttribute('href');
        const norm = (href||'').replace(/\/+$/,'') || '/';
        if (norm === path) a.classList.add('active');
      });
    }catch(e){
      host.innerHTML = '<div style="color:#ffb4b4">Sidebar failed to load.</div>';
    }
  }
  window.addEventListener('DOMContentLoaded', injectSidebar);
})();