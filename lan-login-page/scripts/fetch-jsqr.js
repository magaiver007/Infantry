/**
 * Downloads jsQR browser build into public/lib/jsqr.js
 * Why: keep CSP 'self' and avoid CDNs.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const URLS = [
  'https://unpkg.com/jsqr/dist/jsQR.js',
  'https://cdn.jsdelivr.net/npm/jsqr/dist/jsQR.js'
];

const outDir = path.join(process.cwd(), 'public', 'lib');
const outFile = path.join(outDir, 'jsqr.js');

async function download(url){
  console.log('Fetching', url);
  return new Promise((resolve, reject)=>{
    https.get(url, res=>{
      if(res.statusCode !== 200){
        reject(new Error('HTTP '+res.statusCode));
        res.resume();
        return;
      }
      fs.mkdirSync(outDir, { recursive: true });
      const ws = fs.createWriteStream(outFile);
      res.pipe(ws);
      ws.on('finish', ()=> ws.close(()=> resolve(true)));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

(async ()=>{
  for(const u of URLS){
    try{ await download(u); console.log('Saved ->', outFile); process.exit(0); }catch(e){ console.warn('Failed from', u, e.message); }
  }
  console.error('All sources failed. Download jsQR manually and place it at public/lib/jsqr.js');
  process.exit(1);
})();
