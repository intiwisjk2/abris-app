// ─── Версия кэша app shell ────────────────────────────────────────
// Менять вместе с version.txt при каждом релизе
const CACHE_VERSION = '1.2.12';
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

// Последний рубеж: index.html нет ни в кэше, ни в сети. Никогда не отвечаем
// undefined (это белый экран) — показываем минимальную страницу с кнопкой повтора.
const OFFLINE_FALLBACK_HTML = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Абрис</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
         justify-content: center; gap: 16px; font-family: -apple-system, system-ui, sans-serif;
         background: #101014; color: #e8e8ec; text-align: center; padding: 24px; box-sizing: border-box; }
  p { margin: 0; color: #9a9aa4; font-size: 15px; line-height: 1.5; }
  button { font: inherit; padding: 12px 28px; border: none; border-radius: 12px;
           background: #2c2c34; color: #e8e8ec; }
</style></head><body>
<h1 style="margin:0;font-size:20px">Нет соединения</h1>
<p>Не удалось загрузить приложение.<br>Проверьте интернет и попробуйте снова.</p>
<button onclick="location.reload()">Повторить</button>
</body></html>`;

// ── Установка: кэшируем app shell ────────────────────────────────
// Атомарно (Promise.all): не скачался хоть один файл — install падает,
// старый SW и его полный кэш остаются рабочими, попробуем в следующий раз.
// fetch с no-store — в кэш SW не должны попадать устаревшие копии из HTTP-кэша.
// Снимает с ответа флаг redirected: браузер запрещает отвечать
// redirected-ответом на navigation-запрос (это тихая сетевая ошибка → белый
// экран). Возникает, если хостинг редиректит, например /index.html → /.
async function sanitizeResponse(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.all(
        SHELL_FILES.map(async (f) => {
          const res = await fetch(f, { cache: 'no-store' });
          if (!res.ok) throw new Error(`[SW] HTTP ${res.status}: ${f}`);
          await cache.put(f, await sanitizeResponse(res));
        })
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
// Помечаем ответ, взятый из кэша SW, заголовком — чтобы страница могла
// отличить «настоящий» ответ сети от офлайн-фолбэка (см. checkVersion в app.js).
function markFromCache(res) {
  if (!res) return res;
  const headers = new Headers(res.headers);
  headers.set('X-Abris-From-Cache', '1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function networkFirst(request, cacheName, timeoutMs = 3500) {
  const fromCache = () => caches.match(request).then(markFromCache);
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
        .then(cached => sanitizeResponse(cached)) // в старом кэше мог остаться redirected-ответ
        .then(cached => cached || fetch(request).then(async (res) => {
          // Самовосстановление: кэш потерян, но сеть есть — вернём index.html в кэш
          if (res.ok) {
            const clean = await sanitizeResponse(res.clone());
            caches.open(SHELL_CACHE).then(c => c.put('./index.html', clean));
          }
          return res;
        }))
        .catch(() => new Response(OFFLINE_FALLBACK_HTML, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }))
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
      // Промах кэша: отдаём из сети и кладём в кэш (самовосстановление shell)
      return fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(request, clone));
        }
        return res;
      });
    })
  );
});
