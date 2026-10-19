// 앱 화면은 오프라인에서도 열리게 캐시하고, 항상 새 버전을 먼저 시도해요. 데이터 요청은 캐시하지 않아요.
const CACHE='asset-app-v19';
const SHELL=['./','index.html','config.js','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:'reload'})))));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  // GitHub Pages가 10분 동안 브라우저 캐시를 쓰게 해서, 매번 서버에 새 버전이 있는지 확인함
  e.respondWith(fetch(e.request,{cache:'no-cache'}).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)));
});
