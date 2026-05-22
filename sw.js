// ─── Версия кэша app shell ────────────────────────────────────────
// Менять вместе с version.txt при каждом релизе
const CACHE_VERSION = '1.2.03';
// ─────────────────────────────────────────────────────────────────

const SHELL_CACHE    = `abris-shell-${CACHE_VERSION}`;
const ARTICLES_CACHE = 'abris-articles'; // персистентный, не сбрасывается при обновлении

const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './icon-180.png',
  './icon-512.png',
  './marked.min.js',
];

// ── Установка: кэшируем app shell ────────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()) // сразу активируемся, не ждём закрытия вкладок
  );
});

// ── Активация: удаляем устаревшие shell-кэши ─────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('abris-shell-') && k !== SHELL_CACHE)
          .map(k => {
            console.log('[SW] Удаляем старый кэш:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim()) // берём контроль над всеми вкладками
  );
});

// ── Fetch: стратегии по типам запросов ───────────────────────────
self.addEventListener('fetch', (e) => {
  const request = e.request;
  const url = new URL(request.url);

  // Только same-origin; внешние (шрифты Google и т.д.) — не трогаем
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // version.txt — Network-first, fallback на кеш офлайн (не пропускаем мимо SW)
  if (path.endsWith('version.txt')) {
    e.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(res => {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // articles/index.json — Network-first, кэш как fallback при офлайн
  if (path.endsWith('articles/index.json')) {
    e.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(res => {
          const clone = res.clone();
          caches.open(ARTICLES_CACHE).then(c => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // articles/<id>.enc или .json — Cache-first (статья не изменится после публикации)
  if (path.includes('/articles/')) {
    e.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(res => {
          const clone = res.clone();
          caches.open(ARTICLES_CACHE).then(c => c.put(request, clone));
          return res;
        });
      })
    );
    return;
  }

  // App shell (HTML, JS, CSS, иконки) — Cache-first + фоновое обновление.
  // Сразу отдаём из кеша → нет белого экрана. Обновляем кеш в фоне.
  e.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request, { cache: 'no-store' })
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
