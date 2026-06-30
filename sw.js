// ─── Версия кэша app shell ────────────────────────────────────────
// Менять вместе с version.txt при каждом релизе
const CACHE_VERSION = '1.2.11';
// ─────────────────────────────────────────────────────────────────

const SHELL_CACHE    = `abris-shell-${CACHE_VERSION}`;
const ARTICLES_CACHE = 'abris-articles'; // персистентный, не сбрасывается при обновлении

const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './version.txt',
  './icon.svg',
  './icon-maskable.svg',
  './icon-180.png',
  './icon-512.png',
  './marked.min.js',
];

// ── Установка: кэшируем app shell ────────────────────────────────
// Кэшируем по одному файлу (allSettled): сбой одного ресурса не должен
// срывать весь install и оставлять приложение без офлайна.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.allSettled(
        SHELL_FILES.map(f => cache.add(f).catch(err => {
          console.warn('[SW] Не удалось закэшировать', f, err);
          throw err;
        }))
      ))
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

// Network-first с таймаутом: пытаемся сеть (не дольше timeoutMs), при успехе
// кладём свежий ответ в кэш и отдаём его, при ошибке/таймауте/офлайне — кэш.
// Не зависим от navigator.onLine (ненадёжен на iOS) → новые статьи всегда
// подтягиваются при наличии сети, а офлайн получает мгновенный фолбэк из кэша.
function networkFirst(request, cacheName, timeoutMs = 3500) {
  const fromCache = () => caches.match(request);
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    const timer = setTimeout(() => { fromCache().then(c => { if (c) done(c); }); }, timeoutMs);

    fetch(request, { cache: 'no-store' })
      .then(res => {
        clearTimeout(timer);
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(cacheName).then(c => c.put(request, clone));
          done(res);
        } else {
          // сервер ответил ошибкой — пробуем кэш, иначе отдаём как есть
          fromCache().then(c => done(c || res));
        }
      })
      .catch(() => {
        clearTimeout(timer);
        fromCache().then(c => done(c || Response.error()));
      });
  });
}

// ── Fetch: стратегии по типам запросов ───────────────────────────
self.addEventListener('fetch', (e) => {
  const request = e.request;
  const url = new URL(request.url);

  // Только same-origin; внешние (шрифты Google и т.д.) — не трогаем
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // Навигационные запросы — всегда из кэша, никогда не идём в падающий fetch.
  // Это предотвращает нативный экран iOS «нет интернета» при холодном старте.
  if (request.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html')
        .then(cached => cached || caches.match('./'))
        .then(cached => cached || fetch(request).catch(() => caches.match('./index.html')))
    );
    return;
  }

  // version.txt — network-first с таймаутом, фолбэк на кэш
  if (path.endsWith('version.txt')) {
    e.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // articles/index.json — network-first с таймаутом, фолбэк на кэш
  if (path.endsWith('articles/index.json')) {
    e.respondWith(networkFirst(request, ARTICLES_CACHE));
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
  // Сразу отдаём из кеша → нет белого экрана. Фоновый fetch безопасен офлайн
  // (быстро реджектится по .catch), а при наличии сети обновляет кэш.
  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        fetch(request, { cache: 'no-store' })
          .then(res => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(SHELL_CACHE).then(c => c.put(request, clone));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(request);
    })
  );
});
