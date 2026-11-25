/* Tidal — service worker (offline shell + Web Push).
   IMPORTANT: bump CACHE on every front-end change, or installed clients keep the
   old shell (the precached index.html won't refresh until the SW reinstalls). */
const AI_NAME = "Assistant";      // push-title fallback; keep in sync with index.html CONFIG.AI_NAME
const CACHE = "tidal-v72";
const PRECACHE = [
  "./index.html",
  "./chat-light.webp", "./chat-harbor.webp",
  "./menu-light.webp", "./menu-harbor.webp",
  "./avatar-sea.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 鉴权 API / SSE 必须直连网络：Cache API 不区分 Authorization，
  // 一旦缓存 401，换成正确密钥后仍会持续命中旧响应。
  if (url.pathname.startsWith("/app/") || url.pathname.startsWith("/channel/") || url.pathname.startsWith("/relay/")) return;
  // 子页面（记忆星图 / 感知 / 日志）：网络优先，避免离线壳缓存锁死旧版渲染脚本
  if (url.pathname === "/memory.html" || url.pathname === "/perception.html"
      || url.pathname === "/calendar.html" || url.pathname === "/usage.html"
      || url.pathname === "/settings.html"
      || url.pathname.startsWith("/js/") || url.pathname.startsWith("/styles/")) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  if (e.request.mode === "navigate") {
    // network-first for the page → an online reload always gets the latest index.html
    e.respondWith(fetch(e.request, { cache: "reload" }).catch(() => caches.match("./index.html")));
    return;
  }
  if (e.request.method === "GET" && url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((r) => {
        if (r) return r;
        return fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        });
      })
    );
  }
});

// ── Web Push (VAPID) ──────────────────────────────
// The relay sends a push when the AI replies and no PWA tab is holding the stream;
// here we surface it on the lock screen.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (_) { d = { body: (e.data && e.data.text && e.data.text()) || "" }; }
  // 隐私模式：后端已脱敏；此处再兜底，禁止横幅泄露私密正文
  const privacy = !!d.privacy || d.body === "[收到一条新消息]";
  const title = privacy ? "Tidal" : (d.title || AI_NAME);
  const body  = privacy ? "[收到一条新消息]" : (d.body || "你有一条新消息");
  const tag   = d.id ? ("companion-" + d.id) : "companion-msg";
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon:  "./icon-192.png",
      badge: "./icon-192.png",
      vibrate: [80, 40, 80],
      data: { url: d.url || "./index.html" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./index.html";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cls) => {
      for (const c of cls) {
        if ("focus" in c){
          try { c.navigate(target); } catch (_) {}
          c.postMessage({ type: "backfill" });
          return c.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : null;
    })
  );
});
