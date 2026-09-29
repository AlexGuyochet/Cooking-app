// Service worker : cache hors-ligne de l'app + réception des partages (Android).
const VERSION = "cookbook-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
const INBOX = "share-inbox";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== INBOX).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // 1) Partage reçu depuis la feuille de partage Android (share_target POST)
  if (e.request.method === "POST" && url.origin === location.origin && url.pathname.endsWith("/share")) {
    e.respondWith(receiveShare(e.request));
    return;
  }

  // 2) On ne touche qu'aux fichiers de l'app (pas aux appels Supabase)
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // Réseau d'abord (pour avoir les mises à jour), cache si hors-ligne
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true })
          .then((r) => r || caches.match("./index.html")),
      ),
  );
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const meta = {
      title: String(form.get("title") || ""),
      text: String(form.get("text") || ""),
      url: String(form.get("url") || ""),
      at: Date.now(),
    };
    const cache = await caches.open(INBOX);
    await cache.put("./__shared/meta", new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    const file = form.get("image");
    if (file && typeof file === "object" && file.size > 0) {
      await cache.put("./__shared/image", new Response(file, { headers: { "Content-Type": file.type || "image/jpeg" } }));
    } else {
      await cache.delete("./__shared/image");
    }
  } catch (err) {
    // On ouvre l'app quand même ; elle affichera l'écran d'import vide.
  }
  return Response.redirect("./?shared=1", 303);
}
