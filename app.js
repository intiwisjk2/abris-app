(() => {
  // iOS Safari не применяет :active на кнопках без touchstart-листенера в документе
  document.addEventListener('touchstart', () => {}, { passive: true });

  // ---------- PWA-detection ----------
  const isPWA = () =>
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  const detectDevice = () => {
    const ua = navigator.userAgent;
    // Safari: has "Safari" token but NOT Chrome/CriOS/FxiOS/EdgA/OPiOS/GSA/Edg
    const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgA|OPiOS|GSA|Edg/.test(ua);
    if (/iPhone/.test(ua))                                            return isSafari ? 'iphone' : 'iphone-nosafari';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return isSafari ? 'ipad'   : 'ipad-nosafari';
    if (/Macintosh/.test(ua))                                         return isSafari ? 'mac'    : 'mac-nosafari';
    if (/Android/.test(ua)) return 'android';
    if (/Windows/.test(ua)) return 'windows';
    return 'other'; // Linux и всё остальное
  };

  // ─── Dev-флаг ────────────────────────────────────────────────────
  // true  → показывать экран установки PWA, если открыто не как PWA
  // false → пропускать проверку (для тестирования в браузере)
  const REQUIRE_PWA = true;
  // true  → шифрование включено: .enc файлы + enrollment-авторизация
  // false → режим разработки: .json файлы + старая авторизация
  const REQUIRE_ENCRYPTION = true;
  // ─────────────────────────────────────────────────────────────────

  const app = document.getElementById('app');
  const stickyHeader = document.getElementById('sticky-header');
  const stickyProgressBar = document.getElementById('sticky-progress-bar');

  const CATEGORY_LABEL = { front: 'СВО', russia: 'Россия', world: 'Мир' };

  // ---------- Авторизация ----------
  const AUTH_KEY          = 'auth:authorized';
  const AUTH_DEVICE_KEY   = 'auth:deviceId';
  const AUTH_PASSWORD_KEY = 'auth:password';
  // Старые константы для режима разработки (REQUIRE_ENCRYPTION = false)
  const AUTH_CODE_DEV     = 'a3f72c9be8415d0f194bc037e56a8d21f847c392';
  const AUTH_PASSWORD_DEV = 'o/cs5uhBXQ8Zm8A34FatiR+Ef0csNiR3ZwqP1lY=';

  // Случайный device_id — генерируется один раз, хранится навсегда
  const getOrCreateDeviceId = () => {
    let id = localStorage.getItem(AUTH_DEVICE_KEY);
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(20)); // 160 бит
      id = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(AUTH_DEVICE_KEY, id);
    }
    return id;
  };

  const isAuthorized = () => localStorage.getItem(AUTH_KEY) === '1';

  const markAuthorized = (password = null) => {
    localStorage.setItem(AUTH_KEY, '1');
    if (password) localStorage.setItem(AUTH_PASSWORD_KEY, password);
  };

  const clearAuthorization = () => {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_PASSWORD_KEY);
    masterKey = null;
  };

  // ---------- Тема ----------
  const THEME_KEY = 'pref:theme';

  const getTheme = () => {
    const v = localStorage.getItem(THEME_KEY);
    return (v === 'light' || v === 'dark') ? v : 'system';
  };

  const applyTheme = (theme) => {
    const html = document.documentElement;
    html.classList.remove('theme-light', 'theme-dark');
    if (theme === 'light') html.classList.add('theme-light');
    else if (theme === 'dark') html.classList.add('theme-dark');
  };

  const setTheme = (theme) => {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  };

  applyTheme(getTheme());

  // ---------- Размер шрифта (хранится в localStorage, применяется к article-body) ----------
  const FONT_SCALE_KEY = 'pref:fontScale';
  const FONT_SCALE_OPTIONS = [0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
  const getFontScale = () => {
    const v = parseFloat(localStorage.getItem(FONT_SCALE_KEY));
    return FONT_SCALE_OPTIONS.includes(v) ? v : 1;
  };
  const applyFontScale = (v) => {
    document.documentElement.style.setProperty('--font-scale', String(v));
  };
  const setFontScale = (v) => {
    localStorage.setItem(FONT_SCALE_KEY, String(v));
    applyFontScale(v);
  };
  applyFontScale(getFontScale());

  // ---------- Прочитано ----------
  const isRead = (id) => localStorage.getItem(`read:${id}`) === '1';
  const markRead = (id) => localStorage.setItem(`read:${id}`, '1');

  // ---------- Криптография ----------
  let masterKey = null; // CryptoKey (non-extractable), хранится только в памяти
  let appDb = null;     // IndexedDB instance, доступен после инициализации

  const hexToBytes = (hex) => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  };

  // PBKDF2(password, deviceId) → AES-GCM derived key (32 bytes)
  const deriveKey = async (password, deviceId) => {
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: hexToBytes(deviceId), iterations: 100000, hash: 'SHA-256' },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['decrypt']
    );
  };

  // Расшифровать enrollment-файл и получить master_key как non-extractable CryptoKey
  const unwrapMasterKey = async (enrollmentBuffer, derivedKey) => {
    const data = new Uint8Array(enrollmentBuffer);
    const iv = data.slice(0, 12);
    const wrapped = data.slice(12);
    const masterKeyBytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      derivedKey,
      wrapped
    );
    return crypto.subtle.importKey(
      'raw',
      masterKeyBytes,
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable — нельзя экспортировать через JS
      ['decrypt']
    );
  };

  // Загрузить enrollment-файл и получить master_key
  const loadMasterKey = async (deviceId, password) => {
    const res = await fetch(`enrollments/${deviceId}.bin`, { cache: 'no-store' });
    if (res.status === 404) throw Object.assign(new Error('not-enrolled'), { code: 'not-enrolled' });
    if (!res.ok) throw new Error(`enrollment-fetch-error: ${res.status}`);
    const enrollmentBytes = await res.arrayBuffer();
    const derivedKey = await deriveKey(password, deviceId);
    return unwrapMasterKey(enrollmentBytes, derivedKey);
  };

  // Расшифровать статью из .enc файла
  const decryptArticle = async (encBuffer) => {
    const data = new Uint8Array(encBuffer);
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      masterKey,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(decrypted));
  };

  // ---------- Версия приложения ----------
  const VERSION_KEY = 'app:version';

  const checkVersion = async () => {
    try {
      const res = await fetch('version.txt', { cache: 'no-store' });
      if (!res.ok) return;
      const version = (await res.text()).trim();
      const stored = localStorage.getItem(VERSION_KEY);
      localStorage.setItem(VERSION_KEY, version);
      // Если версия изменилась (и это не первый запуск) — запускаем обновление
      if (stored !== null && stored !== version) triggerUpdate(stored, version);
    } catch (e) { /* офлайн */ }
  };

  // ---------- IndexedDB ----------
  const DB_NAME = 'abris';
  const DB_VERSION = 1;
  const STORE = 'articles';

  const openDB = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });

  const dbGetAll = (db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const dbPut = (db, article) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(article);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  const dbDelete = (db, id) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  // ---------- Последнее обновление ленты ----------
  const LAST_UPDATED_KEY = 'feed:lastUpdated';
  let updateChipTimer = null;
  let updateChipInterval = null;

  const getLastUpdated = () => {
    const v = localStorage.getItem(LAST_UPDATED_KEY);
    if (!v) {
      const now = new Date().toISOString();
      localStorage.setItem(LAST_UPDATED_KEY, now);
      return now;
    }
    return v;
  };
  const setLastUpdated = (iso) => localStorage.setItem(LAST_UPDATED_KEY, iso);

  const lastUpdatedAgo = (isoStr) => {
    const sec = Math.floor((Date.now() - new Date(isoStr)) / 1000);
    if (sec < 60) return 'Только что';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} мин назад`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} ч назад`;
    return `${Math.floor(hr / 24)} дн назад`;
  };

  const clearUpdateChipTimers = () => {
    if (updateChipTimer)    { clearTimeout(updateChipTimer);   updateChipTimer = null; }
    if (updateChipInterval) { clearInterval(updateChipInterval); updateChipInterval = null; }
  };

  const AUTO_REFRESH_INTERVAL = 5 * 60 * 60 * 1000; // 5 часов

  const doRefresh = async (chip, textEl, cardsRoot) => {
    if (!document.contains(chip)) return;

    // Офлайн: сбрасываем таймер (чтобы не зациклиться при каждом запуске),
    // но не делаем сетевых запросов и не меняем UI
    if (!navigator.onLine) {
      setLastUpdated(new Date().toISOString());
      scheduleAutoRefresh(chip, textEl, cardsRoot);
      return;
    }

    const animText = (txt) => {
      textEl.classList.remove('text-anim');
      void textEl.offsetWidth; // force reflow
      textEl.textContent = txt;
      textEl.classList.add('text-anim');
    };

    chip.classList.add('is-refreshing');
    chip.disabled = true;
    animText('Обновляем...');

    let changed = false;
    if (appDb) {
      try {
        changed = await syncArticles(appDb);
        if (changed) window.NEWS = await dbGetAll(appDb);
      } catch (e) { /* сетевая ошибка — данные не изменились */ }
    }

    if (!document.contains(chip)) return;
    const now = new Date().toISOString();
    setLastUpdated(now);
    chip.classList.remove('is-refreshing');
    chip.disabled = false;
    animText(lastUpdatedAgo(now));
    if (changed) renderCards(cardsRoot);
    scheduleAutoRefresh(chip, textEl, cardsRoot);
  };

  const scheduleAutoRefresh = (chip, textEl, cardsRoot) => {
    if (updateChipTimer) clearTimeout(updateChipTimer);
    const elapsed = Date.now() - new Date(getLastUpdated());
    const remaining = AUTO_REFRESH_INTERVAL - elapsed;
    if (remaining <= 0) {
      doRefresh(chip, textEl, cardsRoot);
    } else {
      updateChipTimer = setTimeout(() => doRefresh(chip, textEl, cardsRoot), remaining);
    }
  };

  const setupUpdateChip = (chip, cardsRoot) => {
    const textEl = chip.querySelector('.update-chip-text');
    textEl.textContent = lastUpdatedAgo(getLastUpdated());
    chip.addEventListener('click', () => {
      if (chip.classList.contains('is-refreshing') || chip.disabled) return;
      if (updateChipTimer) { clearTimeout(updateChipTimer); updateChipTimer = null; }
      doRefresh(chip, textEl, cardsRoot);
    });
    updateChipInterval = setInterval(() => {
      if (!document.contains(chip)) { clearUpdateChipTimers(); return; }
      if (!chip.classList.contains('is-refreshing')) {
        textEl.textContent = lastUpdatedAgo(getLastUpdated());
      }
    }, 30000);
    scheduleAutoRefresh(chip, textEl, cardsRoot);
  };

  // ---------- Позиция чтения ----------
  const READPOS_KEY = (id) => `readpos:${id}`;
  let currentArticleId = null;
  let readPosTimer = null;

  const saveReadPosNow = (id) => {
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    if (max <= 0) return;
    const pct = (doc.scrollTop || window.scrollY) / max;
    if (pct >= 0.95 || pct <= 0.02) {
      localStorage.removeItem(READPOS_KEY(id));
    } else {
      localStorage.setItem(READPOS_KEY(id), pct.toFixed(4));
    }
  };

  const scheduleReadPosSave = (id) => {
    if (readPosTimer) clearTimeout(readPosTimer);
    readPosTimer = setTimeout(() => { readPosTimer = null; saveReadPosNow(id); }, 450);
  };

  const restoreReadPos = (id) => {
    const v = localStorage.getItem(READPOS_KEY(id));
    if (v == null) return;
    const pct = parseFloat(v);
    if (!isFinite(pct) || pct <= 0.02) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      if (max > 0) {
        try { window.scrollTo({ top: Math.round(pct * max), behavior: 'instant' }); }
        catch (_) { window.scrollTo(0, Math.round(pct * max)); }
      }
    }));
  };

  // ---------- Утилиты ----------
  const ruPlural = (n, forms) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
    return forms[2];
  };

  const timeAgoShort = (iso, now = new Date()) => {
    const sec = Math.floor((now - new Date(iso)) / 1000);
    if (sec < 60) return 'Только что';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} мин назад`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} ч назад`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} дн назад`;
    const month = Math.floor(day / 30);
    if (month < 12) return `${month} мес назад`;
    return `${Math.floor(day / 365)} г назад`;
  };

  const timeAgo = (iso, now = new Date()) => {
    const then = new Date(iso);
    const sec = Math.floor((now - then) / 1000);
    if (sec < 60) return 'только что';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} ${ruPlural(min, ['минуту', 'минуты', 'минут'])} назад`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} ${ruPlural(hr, ['час', 'часа', 'часов'])} назад`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} ${ruPlural(day, ['день', 'дня', 'дней'])} назад`;
    const week = Math.floor(day / 7);
    if (week < 5) return `${week} ${ruPlural(week, ['неделю', 'недели', 'недель'])} назад`;
    const month = Math.floor(day / 30);
    if (month < 12) return `${month} ${ruPlural(month, ['месяц', 'месяца', 'месяцев'])} назад`;
    const year = Math.floor(day / 365);
    return `${year} ${ruPlural(year, ['год', 'года', 'лет'])} назад`;
  };

  const MONTHS_GEN = [
    'января','февраля','марта','апреля','мая','июня',
    'июля','августа','сентября','октября','ноября','декабря'
  ];

  const formatPeriod = (startIso, endIso) => {
    const s = new Date(startIso), e = new Date(endIso);
    const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
    if (sameMonth) return `${s.getDate()}–${e.getDate()} ${MONTHS_GEN[e.getMonth()]}`;
    return `${s.getDate()} ${MONTHS_GEN[s.getMonth()]} — ${e.getDate()} ${MONTHS_GEN[e.getMonth()]}`;
  };

  const estimateReadMinutes = (markdown) => {
    const words = markdown.replace(/[#>*`_\-\[\]\(\)]/g, ' ').split(/\s+/).filter(Boolean).length;
    const min = Math.max(1, Math.round(words / 180));
    return `${min} ${ruPlural(min, ['минута', 'минуты', 'минут'])} чтения`;
  };

  // ---------- Роутер ----------
  const parseRoute = () => {
    const h = location.hash.replace(/^#/, '') || '/';
    const m = h.match(/^\/article\/([\w\-]+)$/);
    if (m) return { name: 'article', id: m[1] };
    return { name: 'list' };
  };

  // ---------- Список ----------
  let currentFilter = 'all';
  // true после первой синхронизации или если в IndexedDB уже были статьи
  let articlesLoaded = false;

  const renderList = () => {
    clearUpdateChipTimers();
    detachReadingProgress();
    const tpl = document.getElementById('tpl-list').content.cloneNode(true);
    app.replaceChildren(tpl);

    const cards = app.querySelector('#cards');
    const filters = app.querySelectorAll('.filter');

    filters.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.filter === currentFilter);
      btn.addEventListener('click', () => {
        currentFilter = btn.dataset.filter;
        filters.forEach((b) => b.classList.toggle('is-active', b === btn));
        renderCards(cards);
      });
    });

    bindSettingsButtons();
    renderCards(cards);

    const chip = app.querySelector('.js-update-chip');
    if (chip) setupUpdateChip(chip, cards);

    window.scrollTo(0, 0);
    app.classList.remove('page-enter');
    void app.offsetWidth;
    app.classList.add('page-enter');
    const listHeader = app.querySelector('.page-header');
    if (listHeader) listHeader.classList.add('section-enter');

    showStickyHeader();
    stickyHeader.classList.add('sticky-header--list');
    stickyHeader.classList.remove('sticky-header--article');
    setupStickyObserver(app.querySelector('.brand'));
    setupScrollTop();
  };

  const renderSkeletons = (root, count = 3) => {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const li = document.createElement('li');
      li.className = 'card card--skeleton';
      li.setAttribute('aria-hidden', 'true');
      li.innerHTML = `
        <div class="skel-inner">
          <div class="skel-row-top">
            <div class="skel skel--badge"></div>
            <div class="skel skel--time"></div>
          </div>
          <div class="skel skel--title"></div>
          <div class="skel skel--title-short"></div>
          <div class="skel skel--body"></div>
          <div class="skel skel--body-short"></div>
          <div class="skel skel--highlight"></div>
          <div class="skel skel--highlight-med"></div>
          <div class="skel-row-bot">
            <div class="skel skel--meta"></div>
            <div class="skel skel--meta-wide"></div>
          </div>
        </div>`;
      frag.appendChild(li);
    }
    root.appendChild(frag);
  };

  const renderCards = (root) => {
    root.replaceChildren();
    const items = (window.NEWS || [])
      .filter((n) => currentFilter === 'all' || n.category === currentFilter)
      .slice()
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    if (items.length === 0) {
      if (!articlesLoaded) renderSkeletons(root);
      return;
    }

    const tpl = document.getElementById('tpl-card');
    const frag = document.createDocumentFragment();

    items.forEach((n) => {
      const node = tpl.content.cloneNode(true);
      const link = node.querySelector('.card-link');
      const badge = node.querySelector('.badge');
      const time = node.querySelector('.card-time');
      const title = node.querySelector('.card-title');
      const summary = node.querySelector('.card-summary');
      const ul = node.querySelector('.card-highlights');
      const period = node.querySelector('.card-period');
      const read = node.querySelector('.card-read');

      link.href = `#/article/${n.id}`;
      badge.textContent = CATEGORY_LABEL[n.category];
      badge.classList.add(n.category);

      if (!isRead(n.id)) {
        const nb = node.querySelector('.js-new-badge');
        if (nb) nb.hidden = false;
      }
      time.textContent = timeAgoShort(n.publishedAt);
      title.textContent = n.title;
      summary.textContent = n.summary;
      period.textContent = formatPeriod(n.periodStart, n.periodEnd);
      read.textContent = estimateReadMinutes(n.body);

      n.highlights.slice(0, 4).forEach((h) => {
        const li = document.createElement('li');
        li.textContent = h;
        ul.appendChild(li);
      });

      frag.appendChild(node);
    });

    root.appendChild(frag);
  };

  // ---------- Статья ----------
  let scrollHandler = null;
  let stickyObserver = null;

  const attachReadingProgress = (articleId) => {
    currentArticleId = articleId || null;
    const update = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const pct = max > 0 ? Math.min(100, Math.max(0, (doc.scrollTop || window.scrollY) / max * 100)) : 0;
      stickyProgressBar.style.width = pct.toFixed(1) + '%';
      if (articleId) scheduleReadPosSave(articleId);
    };
    scrollHandler = () => requestAnimationFrame(update);
    window.addEventListener('scroll', scrollHandler, { passive: true });
    window.addEventListener('resize', scrollHandler);
    update();
    if (articleId) restoreReadPos(articleId);
  };

  const detachReadingProgress = () => {
    document.documentElement.classList.remove('no-scrollbar');
    removeScrollTopBtn();
    if (currentArticleId) {
      if (readPosTimer) { clearTimeout(readPosTimer); readPosTimer = null; }
      saveReadPosNow(currentArticleId);
      currentArticleId = null;
    }
    stickyProgressBar.style.width = '0%';
    if (scrollHandler) {
      window.removeEventListener('scroll', scrollHandler);
      window.removeEventListener('resize', scrollHandler);
      scrollHandler = null;
    }
    hideStickyHeader();
    removeFloatingAnchor();
    removeFloatingBack();
  };

  // Sticky header — появляется когда верхний тулбар уходит из viewport
  const showStickyHeader = () => {
    stickyHeader.hidden = false;
  };
  const hideStickyHeader = () => {
    if (stickyObserver) {
      stickyObserver.disconnect();
      stickyObserver = null;
    }
    stickyHeader.classList.remove('is-visible');
    stickyHeader.hidden = true;
  };
  const setupStickyObserver = (target) => {
    if (!target || !('IntersectionObserver' in window)) return;
    stickyObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.intersectionRatio === 0 && entry.boundingClientRect.bottom <= 0) {
          stickyHeader.classList.add('is-visible');
        } else {
          stickyHeader.classList.remove('is-visible');
        }
      },
      { threshold: [0, 1] }
    );
    stickyObserver.observe(target);
  };

  const renderArticle = (id) => {
    clearUpdateChipTimers();
    removeScrollTopBtn();
    markRead(id);
    const item = (window.NEWS || []).find((n) => n.id === id);
    if (!item) {
      app.innerHTML = `
        <p style="padding: 24px 0; color: var(--text-2);">
          Новость не найдена. <a href="#/" style="color: var(--accent); text-decoration: underline;">К списку →</a>
        </p>`;
      detachReadingProgress();
      return;
    }

    const tpl = document.getElementById('tpl-article').content.cloneNode(true);
    app.replaceChildren(tpl);

    const badge = app.querySelector('.article-badge');
    badge.textContent = CATEGORY_LABEL[item.category];
    badge.classList.add(item.category);

    app.querySelector('.article-title').textContent = item.title;
    app.querySelector('.article-period').textContent = formatPeriod(item.periodStart, item.periodEnd);
    app.querySelector('.article-time').textContent = timeAgoShort(item.publishedAt);

    const body = app.querySelector('#article-body');
    if (window.marked) {
      marked.setOptions({ breaks: false, gfm: true });
      body.innerHTML = marked.parse(item.body);
    } else {
      body.textContent = item.body;
    }

    body.querySelectorAll('a[href]').forEach((link) => {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    });
    setupAnchors(item.id, body);
    bindSettingsButtons();
    bindAnchorButtons(item.id);
    setupFloatingBack();

    showStickyHeader();
    stickyHeader.classList.add('sticky-header--article');
    stickyHeader.classList.remove('sticky-header--list');

    document.title = `${item.title} · Абрис`;
    window.scrollTo(0, 0);
    app.classList.remove('page-enter');
    void app.offsetWidth;
    app.classList.add('page-enter');

    const hasStoredPos = localStorage.getItem(READPOS_KEY(item.id)) != null;
    const toAnimate = ['.article-toolbar--top', '.article-header'];
    if (!hasStoredPos) toAnimate.push('.article-body');
    toAnimate.forEach((sel, i) => {
      const el = app.querySelector(sel);
      if (el) { el.style.animationDelay = `${i * 70}ms`; el.classList.add('section-enter'); }
    });
    document.documentElement.classList.add('no-scrollbar');
    attachReadingProgress(item.id);
    setupStickyObserver(app.querySelector('.article-toolbar--top'));
  };

  // ---------- Настройки и Confirm-диалог ----------
  const settingsModal = document.getElementById('settings-modal');
  const confirmModal  = document.getElementById('confirm-modal');
  const cacheModal    = document.getElementById('cache-modal');

  const openModal = (m) => {
    m.classList.add('is-open');
    m.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  };
  const closeModal = (m) => {
    m.classList.remove('is-open');
    m.setAttribute('aria-hidden', 'true');
    if (!document.querySelector('.modal.is-open')) {
      document.body.classList.remove('modal-open');
    }
  };
  const closeSettings   = () => closeModal(settingsModal);
  const closeCacheModal = () => closeModal(cacheModal);

  // Таймер разблокировки кнопки «Сбросить» в confirm-modal
  let countdownInterval = null;
  const stopCountdown = () => {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  };
  const closeConfirm = () => { stopCountdown(); closeModal(confirmModal); };

  const refreshSizePicker = () => {
    const cur = getFontScale();
    settingsModal.querySelectorAll('.js-size-picker button').forEach((b) => {
      b.classList.toggle('is-active', parseFloat(b.dataset.size) === cur);
    });
  };

  const refreshThemePicker = () => {
    const cur = getTheme();
    settingsModal.querySelectorAll('.js-theme-picker button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.theme === cur);
    });
  };

  const openSettings = () => {
    refreshSizePicker();
    refreshThemePicker();
    openModal(settingsModal);
  };

  // Запуск обратного отсчёта при открытии confirm-modal
  const openAuthConfirm = () => {
    const btn = confirmModal.querySelector('.js-auth-reset-confirm');
    btn.disabled = true;
    btn.textContent = 'Сбросить (5)';
    let n = 4;
    stopCountdown();
    countdownInterval = setInterval(() => {
      if (n <= 0) {
        stopCountdown();
        btn.disabled = false;
        btn.textContent = 'Сбросить';
      } else {
        btn.textContent = `Сбросить (${n})`;
        n--;
      }
    }, 1000);
    openModal(confirmModal);
  };

  // Закрытие по бэкдропу/крестику для настроек и modal кэша
  [settingsModal, cacheModal].forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeModal(m);
    });
  });
  // Confirm-modal — отдельно, чтобы остановить таймер при закрытии
  confirmModal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { closeConfirm(); return; }
    if (e.target.closest('.js-auth-reset-confirm')) {
      stopCountdown();
      // Очистить всё: localStorage, IndexedDB, перезагрузить
      let reloadScheduled = false;
      const scheduleReload = () => {
        if (reloadScheduled) return;
        reloadScheduled = true;
        setTimeout(() => window.location.reload(), 240);
      };
      localStorage.clear();
      masterKey = null;
      const delReq = indexedDB.deleteDatabase(DB_NAME);
      delReq.onsuccess = delReq.onerror = delReq.onblocked = scheduleReload;
      setTimeout(scheduleReload, 900);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (cacheModal.classList.contains('is-open'))        closeCacheModal();
    else if (confirmModal.classList.contains('is-open')) closeConfirm();
    else if (settingsModal.classList.contains('is-open')) closeSettings();
  });

  // Делегирование внутри настроек: size-picker, theme-picker, действия
  settingsModal.addEventListener('click', (e) => {
    const themeBtn = e.target.closest('.js-theme-picker button');
    if (themeBtn) {
      setTheme(themeBtn.dataset.theme);
      refreshThemePicker();
      return;
    }
    const sizeBtn = e.target.closest('.js-size-picker button');
    if (sizeBtn) {
      const v = parseFloat(sizeBtn.dataset.size);
      if (FONT_SCALE_OPTIONS.includes(v)) {
        setFontScale(v);
        refreshSizePicker();
      }
      return;
    }
    if (e.target.closest('.js-auth-reset')) {
      closeSettings();
      setTimeout(openAuthConfirm, 80);
    }
    if (e.target.closest('.js-cache-reset')) {
      closeSettings();
      setTimeout(() => openModal(cacheModal), 80);
    }
  });

  // Подтверждение сброса кэша
  cacheModal.addEventListener('click', (e) => {
    if (e.target.closest('.js-cache-reset-confirm')) {
      const doReload = () => setTimeout(() => window.location.reload(), 240);
      if ('caches' in window) {
        caches.keys()
          .then(keys => Promise.all(keys.map(k => caches.delete(k))))
          .then(doReload).catch(doReload);
      } else {
        doReload();
      }
    }
  });

  const bindSettingsButtons = () => {
    document.querySelectorAll('.js-settings').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openSettings();
      });
    });
  };

  // ---------- Якорь ----------
  const anchorKey = (id) => `anchor:${id}`;
  const getAnchor = (id) => {
    const v = localStorage.getItem(anchorKey(id));
    return v == null ? null : Number(v);
  };
  const setAnchor = (id, idx) => {
    if (idx == null) localStorage.removeItem(anchorKey(id));
    else localStorage.setItem(anchorKey(id), String(idx));
  };

  const setupAnchors = (articleId, root) => {
    const headings = root.querySelectorAll('h1, h2, h3');
    const stored = getAnchor(articleId);

    headings.forEach((h, i) => {
      h.classList.add('anchorable');
      h.dataset.anchorIndex = String(i);
      h.setAttribute('title', 'Кликните, чтобы поставить или снять якорь');
      if (stored === i) h.classList.add('is-anchored');

      // Иконка закладки — появляется справа в поле выделения когда заголовок выбран
      const bookmarkIcon = document.createElement('span');
      bookmarkIcon.className = 'anchor-bookmark-icon';
      bookmarkIcon.setAttribute('aria-hidden', 'true');
      bookmarkIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
      h.appendChild(bookmarkIcon);

      h.addEventListener('click', () => {
        const cur = getAnchor(articleId);
        if (cur === i) {
          setAnchor(articleId, null);
        } else {
          setAnchor(articleId, i);
        }
        refreshAnchorUI(articleId, root);
      });
    });
  };

  const refreshAnchorUI = (articleId, root) => {
    const cur = getAnchor(articleId);
    root.querySelectorAll('.is-anchored').forEach((el) => el.classList.remove('is-anchored'));
    if (cur != null) {
      const el = root.querySelector(`[data-anchor-index="${cur}"]`);
      if (el) el.classList.add('is-anchored');
    }
    document.querySelectorAll('.js-anchor').forEach((btn) => {
      btn.classList.toggle('is-disabled', cur == null);
      btn.setAttribute('aria-disabled', String(cur == null));
    });
    // Обновить плавающую кнопку сразу после изменения якоря
    if (floatScrollHandler) floatScrollHandler();
  };

  const scrollToAnchorEl = (articleId) => {
    const cur = getAnchor(articleId);
    if (cur == null) return;
    const el = document.querySelector(`#article-body [data-anchor-index="${cur}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const bindAnchorButtons = (articleId) => {
    refreshAnchorUI(articleId, document.getElementById('article-body'));
    document.querySelectorAll('.js-anchor').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (btn.classList.contains('is-disabled')) return;
        scrollToAnchorEl(articleId);
      });
    });
    setupFloatingAnchor(articleId);
  };

  // ---------- Reveal анимация для тела статьи ----------
  // ---------- Плавающая кнопка «К списку» ----------
  let floatBackBtn = null;
  let floatBackObserver = null;

  const removeFloatingBack = () => {
    if (floatBackObserver) { floatBackObserver.disconnect(); floatBackObserver = null; }
    if (floatBackBtn) { floatBackBtn.remove(); floatBackBtn = null; }
  };

  const setupFloatingBack = () => {
    removeFloatingBack();
    floatBackBtn = document.createElement('a');
    floatBackBtn.href = '#/';
    floatBackBtn.className = 'back-float is-hidden';
    floatBackBtn.setAttribute('aria-label', 'К списку');
    floatBackBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
    document.body.appendChild(floatBackBtn);

    if (!('IntersectionObserver' in window)) return;
    const topToolbar = document.querySelector('.article-toolbar--top');
    const bottomToolbar = document.querySelector('.article-toolbar--bottom');

    let topOffscreen = false;
    let bottomOnscreen = false;
    const updateBack = () => {
      floatBackBtn.classList.toggle('is-hidden', !(topOffscreen && !bottomOnscreen));
    };

    floatBackObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.target === topToolbar) {
          topOffscreen = e.intersectionRatio === 0 && e.boundingClientRect.bottom <= 0;
        } else if (e.target === bottomToolbar) {
          bottomOnscreen = e.intersectionRatio > 0;
        }
      });
      updateBack();
    }, { threshold: [0, 0.01, 1] });

    if (topToolbar) floatBackObserver.observe(topToolbar);
    if (bottomToolbar) floatBackObserver.observe(bottomToolbar);
  };

  // ---------- Кнопка «Наверх» на экране списка ----------
  let scrollTopBtn = null;
  let scrollTopHandler = null;

  const removeScrollTopBtn = () => {
    if (scrollTopHandler) { window.removeEventListener('scroll', scrollTopHandler); scrollTopHandler = null; }
    if (scrollTopBtn) { scrollTopBtn.remove(); scrollTopBtn = null; }
  };

  const setupScrollTop = () => {
    removeScrollTopBtn();
    scrollTopBtn = document.createElement('button');
    scrollTopBtn.className = 'scroll-top-float is-hidden';
    scrollTopBtn.setAttribute('aria-label', 'Наверх');
    scrollTopBtn.innerHTML = '<span class="float-arrow">↑</span><span>Наверх</span>';
    scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    document.body.appendChild(scrollTopBtn);

    scrollTopHandler = () => requestAnimationFrame(() => {
      scrollTopBtn.classList.toggle('is-hidden', window.scrollY < 160);
    });
    window.addEventListener('scroll', scrollTopHandler, { passive: true });
  };

  // ---------- Плавающая кнопка к закладке ----------
  let floatGroup = null;
  let floatAddBtn = null;
  let floatDeleteBtn = null;
  let floatBtn = null;
  let floatScrollHandler = null;

  const removeFloatingAnchor = () => {
    if (floatScrollHandler) {
      window.removeEventListener('scroll', floatScrollHandler);
      floatScrollHandler = null;
    }
    if (floatGroup) { floatGroup.remove(); floatGroup = null; }
    if (floatAddBtn) { floatAddBtn.remove(); floatAddBtn = null; }
    floatBtn = null;
    floatDeleteBtn = null;
  };

  const setupFloatingAnchor = (articleId) => {
    removeFloatingAnchor();

    // ── Кнопка «Добавить закладку» (когда закладка не установлена) ──
    floatAddBtn = document.createElement('button');
    floatAddBtn.className = 'anchor-add-float is-hidden';
    floatAddBtn.setAttribute('aria-label', 'Добавить закладку');
    floatAddBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
    floatAddBtn.addEventListener('click', () => {
      const headings = Array.from(document.querySelectorAll('#article-body [data-anchor-index]'));
      if (!headings.length) return;

      // Заголовки, полностью видимые на экране
      const visible = headings.filter((h) => {
        const r = h.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });

      let target = null;
      if (visible.length > 0) {
        // Самый верхний из видимых
        target = visible.reduce((best, h) =>
          h.getBoundingClientRect().top < best.getBoundingClientRect().top ? h : best
        );
      } else {
        // Ближайший выше viewport (уже прокрутили мимо него)
        const above = headings.filter((h) => h.getBoundingClientRect().bottom < 0);
        if (above.length > 0) {
          target = above.reduce((best, h) =>
            h.getBoundingClientRect().bottom > best.getBoundingClientRect().bottom ? h : best
          );
        }
      }

      if (target) {
        const idx = parseInt(target.dataset.anchorIndex, 10);
        const body = document.getElementById('article-body');
        setAnchor(articleId, idx);
        if (body) refreshAnchorUI(articleId, body);
      }
    });
    document.body.appendChild(floatAddBtn);

    // ── Группа «К закладке» + «Удалить» (когда закладка установлена) ──
    floatGroup = document.createElement('div');
    floatGroup.className = 'anchor-float-group';

    floatBtn = document.createElement('button');
    floatBtn.className = 'anchor-float is-hidden';
    floatBtn.innerHTML = '<span class="float-arrow">↑</span><span>К закладке</span>';
    floatBtn.addEventListener('click', () => scrollToAnchorEl(articleId));

    floatDeleteBtn = document.createElement('button');
    floatDeleteBtn.className = 'anchor-delete-float is-hidden';
    floatDeleteBtn.setAttribute('aria-label', 'Удалить закладку');
    floatDeleteBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg><span class="anchor-delete-float-text">Удалить закладку</span>`;
    floatDeleteBtn.addEventListener('click', () => {
      const body = document.getElementById('article-body');
      setAnchor(articleId, null);
      if (body) refreshAnchorUI(articleId, body);
    });

    floatGroup.appendChild(floatBtn);
    floatGroup.appendChild(floatDeleteBtn);
    document.body.appendChild(floatGroup);

    const hideAll = () => {
      floatAddBtn.classList.add('is-hidden');
      floatBtn.classList.add('is-hidden');
      floatDeleteBtn.classList.add('is-hidden');
      floatDeleteBtn.classList.remove('has-text');
    };

    const update = () => {
      const cur = getAnchor(articleId);

      // Если виден любой тулбар-якорь — убираем всё
      const toolbarBtns = document.querySelectorAll('.js-anchor');
      const anyToolbarVisible = Array.from(toolbarBtns).some((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      if (anyToolbarVisible) { hideAll(); return; }

      if (cur == null) {
        // Закладка не установлена — показываем кнопку добавления
        floatAddBtn.classList.remove('is-hidden');
        floatBtn.classList.add('is-hidden');
        floatDeleteBtn.classList.add('is-hidden');
        floatDeleteBtn.classList.remove('has-text');
        return;
      }

      // Закладка установлена
      floatAddBtn.classList.add('is-hidden');

      const anchorEl = document.querySelector(`#article-body [data-anchor-index="${cur}"]`);
      if (!anchorEl) { hideAll(); return; }

      const rect = anchorEl.getBoundingClientRect();
      const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;

      if (inView) {
        // Заголовок виден — скрываем «К закладке», показываем удаление с текстом
        floatBtn.classList.add('is-hidden');
        floatDeleteBtn.classList.remove('is-hidden');
        floatDeleteBtn.classList.add('has-text');
      } else {
        // Заголовок за экраном — обе кнопки группы
        floatBtn.classList.remove('is-hidden');
        floatDeleteBtn.classList.remove('is-hidden');
        floatDeleteBtn.classList.remove('has-text');
        const anchorCenter = (rect.top + rect.bottom) / 2;
        floatBtn.querySelector('.float-arrow').textContent =
          anchorCenter > window.innerHeight / 2 ? '↓' : '↑';
      }
    };

    floatScrollHandler = () => requestAnimationFrame(update);
    window.addEventListener('scroll', floatScrollHandler, { passive: true });
    update();
  };

  // ---------- Онбординг ----------
  const ONBOARDING_KEY = 'onboarding:done';
  const isOnboardingDone  = () => localStorage.getItem(ONBOARDING_KEY) === '1';
  const markOnboardingDone = () => localStorage.setItem(ONBOARDING_KEY, '1');

  const renderOnboarding = (onComplete) => {
    const SLIDES = [
      // ── Слайд 1: Добро пожаловать ──────────────────────────────────
      {
        title: 'Добро пожаловать в Абрис',
        text:  'Новостное приложение нового поколения.',
        illus: `<svg viewBox="0 0 320 192" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle class="ob-orbit-line" cx="160" cy="96" r="88" stroke="#a83318" stroke-width="0.8" stroke-opacity="0.08"/>
          <circle class="ob-orbit-line" cx="160" cy="96" r="68" stroke="#a83318" stroke-width="0.8" stroke-opacity="0.11"/>
          <g class="ob-orbit-ticks" stroke="#a83318" stroke-width="1.4" stroke-opacity="0.13" stroke-linecap="round">
            <line x1="248" y1="96" x2="243" y2="96"/>
            <line x1="236.5" y1="139" x2="232.1" y2="136.4"/>
            <line x1="204" y1="172" x2="201.5" y2="167.9"/>
            <line x1="160" y1="184" x2="160" y2="179"/>
            <line x1="116" y1="172" x2="118.5" y2="167.9"/>
            <line x1="83.5" y1="139" x2="87.9" y2="136.4"/>
            <line x1="72" y1="96" x2="77" y2="96"/>
            <line x1="83.5" y1="53" x2="87.9" y2="55.6"/>
            <line x1="116" y1="20" x2="118.5" y2="24.1"/>
            <line x1="160" y1="8" x2="160" y2="13"/>
            <line x1="204" y1="20" x2="201.5" y2="24.1"/>
            <line x1="236.5" y1="53" x2="232.1" y2="55.6"/>
          </g>
          <circle cx="160" cy="96" r="48" fill="#f2e0ce" fill-opacity="0.45"/>
          <image href="icon.svg" x="112" y="48" width="96" height="96"/>
        </svg>`,
      },
      // ── Слайд 2: Конец новостному шуму ─────────────────────────────
      {
        title: 'Конец новостному шуму',
        text:  'Не следите за лентой круглосуточно — замените это еженедельной сводкой.',
        illus: `<svg viewBox="0 0 320 192" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect x="8" y="52" width="38" height="56" rx="7" fill="#1a1a1c" fill-opacity="0.04" stroke="#1a1a1c" stroke-width="0.6" stroke-opacity="0.07"/>
          <text x="27" y="67" text-anchor="middle" font-size="8" fill="#1a1a1c" fill-opacity="0.35" font-family="system-ui">Пн</text>
          <circle cx="20" cy="80" r="4" fill="#a83318" fill-opacity="0.3"/>
          <circle cx="34" cy="80" r="3" fill="#a83318" fill-opacity="0.22"/>
          <circle cx="27" cy="92" r="4.5" fill="#a83318" fill-opacity="0.27"/>
          <rect x="50" y="52" width="38" height="56" rx="7" fill="#1a1a1c" fill-opacity="0.04" stroke="#1a1a1c" stroke-width="0.6" stroke-opacity="0.07"/>
          <text x="69" y="67" text-anchor="middle" font-size="8" fill="#1a1a1c" fill-opacity="0.35" font-family="system-ui">Вт</text>
          <circle cx="62" cy="80" r="3.5" fill="#a83318" fill-opacity="0.28"/>
          <circle cx="76" cy="78" r="4" fill="#a83318" fill-opacity="0.22"/>
          <circle cx="66" cy="91" r="3" fill="#a83318" fill-opacity="0.2"/>
          <rect x="92" y="52" width="38" height="56" rx="7" fill="#1a1a1c" fill-opacity="0.04" stroke="#1a1a1c" stroke-width="0.6" stroke-opacity="0.07"/>
          <text x="111" y="67" text-anchor="middle" font-size="8" fill="#1a1a1c" fill-opacity="0.35" font-family="system-ui">Ср</text>
          <circle cx="104" cy="81" r="4" fill="#a83318" fill-opacity="0.25"/>
          <circle cx="118" cy="80" r="3" fill="#a83318" fill-opacity="0.2"/>
          <circle cx="111" cy="92" r="4" fill="#a83318" fill-opacity="0.28"/>
          <rect x="134" y="52" width="38" height="56" rx="7" fill="#1a1a1c" fill-opacity="0.04" stroke="#1a1a1c" stroke-width="0.6" stroke-opacity="0.07"/>
          <text x="153" y="67" text-anchor="middle" font-size="8" fill="#1a1a1c" fill-opacity="0.35" font-family="system-ui">Чт</text>
          <circle cx="146" cy="80" r="3.5" fill="#a83318" fill-opacity="0.22"/>
          <circle cx="160" cy="79" r="4.5" fill="#a83318" fill-opacity="0.3"/>
          <circle cx="152" cy="91" r="3" fill="#a83318" fill-opacity="0.2"/>
          <rect x="176" y="52" width="38" height="56" rx="7" fill="#1a1a1c" fill-opacity="0.04" stroke="#1a1a1c" stroke-width="0.6" stroke-opacity="0.07"/>
          <text x="195" y="67" text-anchor="middle" font-size="8" fill="#1a1a1c" fill-opacity="0.35" font-family="system-ui">Пт</text>
          <circle cx="188" cy="81" r="4" fill="#a83318" fill-opacity="0.27"/>
          <circle cx="202" cy="80" r="3.5" fill="#a83318" fill-opacity="0.22"/>
          <circle cx="194" cy="92" r="4" fill="#a83318" fill-opacity="0.25"/>
          <rect x="218" y="52" width="38" height="56" rx="7" fill="#1a1a1c" fill-opacity="0.04" stroke="#1a1a1c" stroke-width="0.6" stroke-opacity="0.07"/>
          <text x="237" y="67" text-anchor="middle" font-size="8" fill="#1a1a1c" fill-opacity="0.35" font-family="system-ui">Сб</text>
          <circle cx="230" cy="80" r="3" fill="#a83318" fill-opacity="0.2"/>
          <circle cx="244" cy="81" r="4" fill="#a83318" fill-opacity="0.25"/>
          <circle cx="236" cy="92" r="3.5" fill="#a83318" fill-opacity="0.22"/>
          <rect x="260" y="52" width="52" height="56" rx="7" fill="#f2e0ce" fill-opacity="0.5" stroke="#a83318" stroke-width="1.2" stroke-opacity="0.35"/>
          <text x="286" y="67" text-anchor="middle" font-size="8" fill="#a83318" fill-opacity="0.8" font-family="system-ui" font-weight="700">Вс</text>
          <rect x="272" y="75" width="28" height="20" rx="3" fill="#a83318" fill-opacity="0.12"/>
          <line x1="286" y1="75" x2="286" y2="95" stroke="#a83318" stroke-width="1" stroke-opacity="0.4"/>
          <rect x="274" y="78" width="10" height="3" rx="1.5" fill="#a83318" fill-opacity="0.35"/>
          <rect x="274" y="84" width="10" height="3" rx="1.5" fill="#a83318" fill-opacity="0.28"/>
          <rect x="288" y="78" width="10" height="3" rx="1.5" fill="#a83318" fill-opacity="0.35"/>
          <rect x="288" y="84" width="10" height="3" rx="1.5" fill="#a83318" fill-opacity="0.28"/>
          <rect x="40" y="120" width="240" height="48" rx="10" fill="white" fill-opacity="0.9" stroke="#1a1a1c" stroke-width="0.8" stroke-opacity="0.09"/>
          <rect x="52" y="130" width="50" height="12" rx="6" fill="#f6e6dc"/>
          <rect x="58" y="134" width="38" height="4" rx="2" fill="#a83318" fill-opacity="0.55"/>
          <rect x="52" y="147" width="202" height="6" rx="3" fill="#1a1a1c" fill-opacity="0.18"/>
          <rect x="52" y="157" width="176" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.12"/>
        </svg>`,
      },
      // ── Слайд 3: Глубокий анализ СМИ ────────────────────────────────
      {
        title: 'Глубокий анализ СМИ',
        text:  'ИИ анализирует сотни статей из разных СМИ и формирует картину недели.',
        illus: `<svg viewBox="0 0 300 192" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="150" cy="90" r="74" stroke="currentColor" stroke-width="1.4" opacity="0.07" fill="none"/>
          <ellipse cx="150" cy="90" rx="74" ry="27" stroke="currentColor" stroke-width="1" opacity="0.06" fill="none"/>
          <ellipse cx="150" cy="90" rx="74" ry="50" stroke="currentColor" stroke-width="1" opacity="0.04" fill="none"/>
          <line x1="76" y1="90" x2="224" y2="90" stroke="currentColor" stroke-width="1" opacity="0.06"/>
          <line x1="150" y1="16" x2="150" y2="164" stroke="currentColor" stroke-width="1" opacity="0.06"/>
          <rect x="108" y="1" width="84" height="48" rx="10" fill="currentColor" opacity="0.06" stroke="currentColor" stroke-width="0.8" stroke-opacity="0.1"/>
          <rect x="118" y="11" width="64" height="9" rx="4.5" fill="currentColor" opacity="0.2"/>
          <rect x="118" y="24" width="48" height="7" rx="3.5" fill="currentColor" opacity="0.14"/>
          <rect x="118" y="35" width="56" height="7" rx="3.5" fill="currentColor" opacity="0.1"/>
          <rect x="238" y="58" width="60" height="46" rx="10" fill="currentColor" opacity="0.06" stroke="currentColor" stroke-width="0.8" stroke-opacity="0.1"/>
          <rect x="248" y="68" width="40" height="9" rx="4.5" fill="currentColor" opacity="0.2"/>
          <rect x="248" y="81" width="30" height="7" rx="3.5" fill="currentColor" opacity="0.14"/>
          <rect x="248" y="92" width="36" height="7" rx="3.5" fill="currentColor" opacity="0.1"/>
          <rect x="108" y="148" width="84" height="44" rx="10" fill="currentColor" opacity="0.06" stroke="currentColor" stroke-width="0.8" stroke-opacity="0.1"/>
          <rect x="118" y="158" width="64" height="9" rx="4.5" fill="currentColor" opacity="0.2"/>
          <rect x="118" y="171" width="48" height="7" rx="3.5" fill="currentColor" opacity="0.14"/>
          <rect x="118" y="182" width="56" height="7" rx="3.5" fill="currentColor" opacity="0.1"/>
          <rect x="2" y="58" width="60" height="46" rx="10" fill="currentColor" opacity="0.06" stroke="currentColor" stroke-width="0.8" stroke-opacity="0.1"/>
          <rect x="12" y="68" width="40" height="9" rx="4.5" fill="currentColor" opacity="0.2"/>
          <rect x="12" y="81" width="30" height="7" rx="3.5" fill="currentColor" opacity="0.14"/>
          <rect x="12" y="92" width="36" height="7" rx="3.5" fill="currentColor" opacity="0.1"/>
          <line x1="150" y1="49" x2="150" y2="66" stroke="currentColor" opacity="0.11" stroke-width="1.5" stroke-dasharray="3 2"/>
          <line x1="238" y1="81" x2="204" y2="85" stroke="currentColor" opacity="0.11" stroke-width="1.5" stroke-dasharray="3 2"/>
          <line x1="150" y1="148" x2="150" y2="114" stroke="currentColor" opacity="0.11" stroke-width="1.5" stroke-dasharray="3 2"/>
          <line x1="62" y1="81" x2="96" y2="85" stroke="currentColor" opacity="0.11" stroke-width="1.5" stroke-dasharray="3 2"/>
          <circle cx="150" cy="90" r="32" fill="#f2e0ce" opacity="0.9"/>
          <circle cx="150" cy="90" r="32" stroke="#a83318" stroke-width="1.5" opacity="0.22" fill="none"/>
          <path d="M150 72.5 L155.5 86 L170 90 L155.5 94 L150 107.5 L144.5 94 L130 90 L144.5 86 Z" fill="#a83318" opacity="0.78"/>
          <circle cx="150" cy="90" r="3" fill="white" opacity="0.55"/>
        </svg>`,
      },
      // ── Слайд 4: Читайте в удобном темпе ───────────────────────────
      {
        title: 'Читайте в удобном темпе',
        text:  'Возвращайтесь в любой момент — приложение запомнит, где вы остановились.',
        illus: `<svg viewBox="0 0 320 192" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <line x1="30" y1="80" x2="290" y2="80" stroke="#1a1a1c" stroke-width="1.2" stroke-opacity="0.1"/>
          <line x1="60" y1="80" x2="160" y2="80" stroke="#a83318" stroke-width="2.5" stroke-opacity="0.55"/>
          <line x1="160" y1="80" x2="268" y2="80" stroke="#a83318" stroke-width="2" stroke-opacity="0.25" stroke-dasharray="4 4"/>
          <circle cx="60" cy="80" r="8" fill="#fff" stroke="#1a1a1c" stroke-width="1.5" stroke-opacity="0.15"/>
          <circle cx="160" cy="80" r="10" fill="#f2e0ce" stroke="#a83318" stroke-width="1.5" stroke-opacity="0.6"/>
          <path d="M156 75 L164 75 L164 85 L160 82 L156 85 Z" fill="#a83318" fill-opacity="0.65"/>
          <text x="160" y="66" text-anchor="middle" font-size="8" fill="#a83318" fill-opacity="0.7" font-family="system-ui" font-weight="600">Вы здесь</text>
          <circle cx="268" cy="80" r="8" fill="#fff" stroke="#1a1a1c" stroke-width="1" stroke-opacity="0.1"/>
          <path d="M263 80 L266 83 L273 76" stroke="#1a1a1c" stroke-width="1.5" stroke-opacity="0.2" stroke-linecap="round" stroke-linejoin="round"/>
          <rect x="16" y="98" width="88" height="52" rx="8" fill="#fff" fill-opacity="0.7" stroke="#1a1a1c" stroke-width="0.6" stroke-opacity="0.08"/>
          <rect x="24" y="106" width="32" height="8" rx="4" fill="#f6e6dc"/>
          <rect x="24" y="118" width="70" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.14"/>
          <rect x="24" y="127" width="58" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.1"/>
          <rect x="24" y="136" width="64" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.08"/>
          <rect x="116" y="98" width="88" height="52" rx="8" fill="#fff" stroke="#a83318" stroke-width="0.9" stroke-opacity="0.35"/>
          <rect x="124" y="106" width="32" height="8" rx="4" fill="#f6e6dc"/>
          <rect x="124" y="118" width="70" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.18"/>
          <rect x="124" y="127" width="58" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.13"/>
          <rect x="124" y="136" width="64" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.1"/>
          <rect x="222" y="98" width="88" height="52" rx="8" fill="#fff" fill-opacity="0.4" stroke="#1a1a1c" stroke-width="0.6" stroke-opacity="0.06"/>
          <rect x="230" y="106" width="32" height="8" rx="4" fill="#f6e6dc" fill-opacity="0.5"/>
          <rect x="230" y="118" width="70" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.07"/>
          <rect x="230" y="127" width="58" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.06"/>
          <rect x="230" y="136" width="64" height="5" rx="2.5" fill="#1a1a1c" fill-opacity="0.05"/>
        </svg>`,
      },
      // ── Слайд 5: Только для своих ───────────────────────────────────
      {
        title: 'Только для своих',
        text:  'Абрис — закрытый проект для небольшого круга пользователей. Пожалуйста, не делитесь ссылкой.',
        illus: `<svg viewBox="0 -16 280 206" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="140" cy="95" r="82" fill="#f2e0ce" opacity="0.18"/>
          <circle cx="140" cy="95" r="82" stroke="#a83318" stroke-width="1.2" opacity="0.12" fill="none" stroke-dasharray="5 4"/>
          <line x1="150" y1="25"  x2="204" y2="60"  stroke="#a83318" stroke-width="1.1" opacity="0.14"/>
          <line x1="214" y1="82"  x2="200" y2="147" stroke="#a83318" stroke-width="1.1" opacity="0.14"/>
          <line x1="178" y1="162" x2="102" y2="162" stroke="#a83318" stroke-width="1.1" opacity="0.14"/>
          <line x1="80"  y1="147" x2="66"  y2="82"  stroke="#a83318" stroke-width="1.1" opacity="0.14"/>
          <line x1="76"  y1="60"  x2="130" y2="25"  stroke="#a83318" stroke-width="1.1" opacity="0.14"/>
          <g transform="translate(140 13)">
            <circle r="14" fill="#f6e6dc" stroke="#a83318" stroke-width="1.5" stroke-opacity="0.6"/>
            <circle cy="-4.5" r="3.5" fill="#a83318" fill-opacity="0.7"/>
            <path d="M-9 9.5 C-7 4.2 -3.6 1.7 0 1.7 C3.6 1.7 7 4.2 9 9.5 Z" fill="#a83318" fill-opacity="0.55"/>
          </g>
          <g transform="translate(216 68)">
            <circle r="14" fill="#f6e6dc" stroke="#a83318" stroke-width="1.5" stroke-opacity="0.6"/>
            <circle cy="-4.5" r="3.5" fill="#a83318" fill-opacity="0.7"/>
            <path d="M-9 9.5 C-7 4.2 -3.6 1.7 0 1.7 C3.6 1.7 7 4.2 9 9.5 Z" fill="#a83318" fill-opacity="0.55"/>
          </g>
          <g transform="translate(188 160)">
            <circle r="14" fill="#f6e6dc" stroke="#a83318" stroke-width="1.5" stroke-opacity="0.6"/>
            <circle cy="-4.5" r="3.5" fill="#a83318" fill-opacity="0.7"/>
            <path d="M-9 9.5 C-7 4.2 -3.6 1.7 0 1.7 C3.6 1.7 7 4.2 9 9.5 Z" fill="#a83318" fill-opacity="0.55"/>
          </g>
          <g transform="translate(92 160)">
            <circle r="14" fill="#f6e6dc" stroke="#a83318" stroke-width="1.5" stroke-opacity="0.6"/>
            <circle cy="-4.5" r="3.5" fill="#a83318" fill-opacity="0.7"/>
            <path d="M-9 9.5 C-7 4.2 -3.6 1.7 0 1.7 C3.6 1.7 7 4.2 9 9.5 Z" fill="#a83318" fill-opacity="0.55"/>
          </g>
          <g transform="translate(64 68)">
            <circle r="14" fill="#f6e6dc" stroke="#a83318" stroke-width="1.5" stroke-opacity="0.6"/>
            <circle cy="-4.5" r="3.5" fill="#a83318" fill-opacity="0.7"/>
            <path d="M-9 9.5 C-7 4.2 -3.6 1.7 0 1.7 C3.6 1.7 7 4.2 9 9.5 Z" fill="#a83318" fill-opacity="0.55"/>
          </g>
          <image href="icon.svg" x="104" y="59" width="72" height="72"/>
        </svg>`,
      },
    ];
    let idx = 0;

    const overlay = document.createElement('div');
    overlay.className = 'onboarding-overlay';
    overlay.innerHTML = `
      <div class="ob-card">
        <div class="ob-content"></div>
        <div class="ob-dots">
          ${SLIDES.map(() => `<span class="ob-dot" aria-hidden="true"></span>`).join('')}
        </div>
        <div class="ob-actions">
          <button class="ob-back js-ob-back" type="button" hidden aria-label="Назад">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button class="ob-next js-ob-next" type="button">
            <span class="ob-next-text">Далее</span>
            <span class="ob-next-spinner" aria-hidden="true"></span>
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const contentEl = overlay.querySelector('.ob-content');
    const dotsEls   = overlay.querySelectorAll('.ob-dot');
    const backBtn   = overlay.querySelector('.js-ob-back');
    const nextBtn   = overlay.querySelector('.js-ob-next');

    const updateNav = () => {
      dotsEls.forEach((d, i) => d.classList.toggle('is-active', i === idx));
      backBtn.hidden = idx === 0;
      nextBtn.querySelector('.ob-next-text').textContent = idx === SLIDES.length - 1 ? 'Начать' : 'Далее';
    };

    const setContent = () => {
      const s = SLIDES[idx];
      contentEl.innerHTML = `
        <div class="ob-illustration">${s.illus}</div>
        <h2 class="ob-title">${s.title}</h2>
        <p class="ob-text">${s.text}</p>
        ${s.notice ? `<p class="ob-notice">${s.notice}</p>` : ''}`;
    };

    const goTo = (newIdx, dir) => {
      contentEl.style.transition = 'opacity 160ms ease, transform 160ms ease';
      contentEl.style.opacity    = '0';
      contentEl.style.transform  = `translateX(${dir > 0 ? -18 : 18}px)`;

      setTimeout(() => {
        idx = newIdx;
        setContent();
        contentEl.style.transition = 'none';
        contentEl.style.opacity    = '0';
        contentEl.style.transform  = `translateX(${dir > 0 ? 18 : -18}px)`;
        updateNav();

        requestAnimationFrame(() => requestAnimationFrame(() => {
          contentEl.style.transition = 'opacity 300ms cubic-bezier(0.22, 1, 0.36, 1), transform 300ms cubic-bezier(0.22, 1, 0.36, 1)';
          contentEl.style.opacity    = '1';
          contentEl.style.transform  = 'none';
        }));
      }, 160);
    };

    setContent();
    updateNav();

    backBtn.addEventListener('click', () => { if (idx > 0) goTo(idx - 1, -1); });
    nextBtn.addEventListener('click', () => {
      if (idx < SLIDES.length - 1) {
        goTo(idx + 1, 1);
      } else {
        nextBtn.classList.add('is-loading');
        nextBtn.disabled = true;
        backBtn.disabled = true;
        onComplete();
      }
    });
  };

  // ---------- Экран авторизации ----------
  const renderAuth = () => {
    detachReadingProgress();
    const tpl = document.getElementById('tpl-auth').content.cloneNode(true);
    app.replaceChildren(tpl);
    document.title = 'Авторизация · Абрис';
    window.scrollTo(0, 0);

    const step1         = app.querySelector('.js-step-1');
    const step2         = app.querySelector('.js-step-2');
    const codeEl        = app.querySelector('.js-auth-code');
    const copyBtn       = app.querySelector('.js-auth-copy');
    const nextBtn       = app.querySelector('.js-auth-next');
    const pasteSubmit   = app.querySelector('.js-auth-paste-submit');
    const backBtn       = app.querySelector('.js-auth-back');
    const errorEl       = app.querySelector('.js-auth-error');
    const errorText     = app.querySelector('.js-auth-error-text');

    codeEl.textContent = REQUIRE_ENCRYPTION ? getOrCreateDeviceId() : AUTH_CODE_DEV;

    // ── Утилита перехода между шагами ──
    const goToStep = (from, to) => {
      from.classList.add('auth-step-leave');
      setTimeout(() => {
        from.hidden = true;
        from.classList.remove('auth-step-leave');
        to.hidden = false;
        // Сброс анимации при повторном показе
        to.classList.remove('auth-step-enter');
        void to.offsetWidth;
        to.classList.add('auth-step-enter');
      }, 210);
    };

    // ── Копирование кода ──
    const copyCode = async () => {
      const codeToCopy = REQUIRE_ENCRYPTION ? getOrCreateDeviceId() : AUTH_CODE_DEV;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(codeToCopy);
        } else {
          const range = document.createRange();
          range.selectNodeContents(codeEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('copy');
          sel.removeAllRanges();
        }
        copyBtn.classList.add('is-done');
        // Через 1800мс — анимированный возврат к «Копировать»
        setTimeout(() => {
          copyBtn.classList.add('is-reverting');
          setTimeout(() => {
            copyBtn.classList.remove('is-done', 'is-reverting');
            copyBtn.classList.add('is-returning');
            setTimeout(() => copyBtn.classList.remove('is-returning'), 320);
          }, 180);
        }, 1600);
      } catch (e) { /* silent */ }
    };
    copyBtn.addEventListener('click', copyCode);

    // ── Переход на шаг 2 ──
    nextBtn.addEventListener('click', () => {
      hideError();
      goToStep(step1, step2);
    });

    // ── Кнопка «Назад» ──
    backBtn.addEventListener('click', () => {
      hideError();
      goToStep(step2, step1);
    });

    // ── Показ/скрытие ошибки ──
    const showError = (msg) => {
      errorText.textContent = msg;
      errorEl.classList.remove('is-visible');
      errorEl.hidden = false;
      void errorEl.offsetWidth; // перезапуск анимации
      errorEl.classList.add('is-visible');
    };
    const hideError = () => {
      errorEl.hidden = true;
      errorEl.classList.remove('is-visible');
    };

    // ── Вставить пароль из буфера и сразу авторизоваться ──
    let isChecking = false;
    pasteSubmit.addEventListener('click', async () => {
      if (isChecking) return;

      // Читаем пароль из буфера
      let password;
      try {
        if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) {
          password = (await navigator.clipboard.readText()).trim();
        } else {
          showError('Буфер обмена недоступен в этом браузере');
          return;
        }
      } catch (e) {
        showError('Не удалось прочитать буфер обмена');
        return;
      }

      if (!password) {
        showError('Буфер обмена пуст');
        return;
      }

      hideError();
      isChecking = true;
      pasteSubmit.classList.add('is-loading');
      pasteSubmit.disabled = true;

      if (REQUIRE_ENCRYPTION) {
        // Боевой режим: проверяем через enrollment-файл
        const deviceId = getOrCreateDeviceId();
        try {
          masterKey = await loadMasterKey(deviceId, password);
          markAuthorized(password);
          pasteSubmit.classList.remove('is-loading');
          pasteSubmit.disabled = false;
          isChecking = false;
          if (!isOnboardingDone()) {
            renderOnboarding(() => { markOnboardingDone(); window.location.reload(); });
          } else {
            setTimeout(() => window.location.reload(), 240);
          }
        } catch (err) {
          masterKey = null;
          pasteSubmit.classList.remove('is-loading');
          pasteSubmit.disabled = false;
          isChecking = false;
          if (err.code === 'not-enrolled') {
            showError('Устройство не зарегистрировано. Отправьте код владельцу.');
          } else {
            showError('Неверный пароль');
          }
        }
      } else {
        // Режим разработки: проверяем старым способом
        setTimeout(() => {
          pasteSubmit.classList.remove('is-loading');
          pasteSubmit.disabled = false;
          isChecking = false;

          if (password !== AUTH_PASSWORD_DEV) {
            showError('Неверный пароль — попробуйте ещё раз');
            return;
          }
          markAuthorized();
          if (!isOnboardingDone()) {
            renderOnboarding(() => { markOnboardingDone(); window.location.reload(); });
          } else {
            setTimeout(() => window.location.reload(), 240);
          }
        }, 1200);
      }
    });
  };

  // ---------- Экран установки ----------
  const renderInstall = (device) => {
    detachReadingProgress();
    document.title = 'Установите Абрис';
    window.scrollTo(0, 0);

    const logoSVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <style>
        .al-bg { fill: #f2e0ce; }
        .al-s  { stroke: #a83318; }
        @media (prefers-color-scheme: dark) {
          .al-bg { fill: #1a1a1f; }
          .al-s  { stroke: #e87a4f; }
        }
      </style>
      <rect class="al-bg" width="100" height="100"/>
      <g class="al-s" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" fill="none">
        <line x1="50" y1="17" x2="13" y2="83"/>
        <line x1="50" y1="17" x2="87" y2="83"/>
        <line x1="28" y1="56" x2="72" y2="56"/>
      </g>
    </svg>`;

    // ── Общие иконки/хелперы для всех экранов ──────────────────────
    const iconAttrs = 'width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

    const icons = {
      share:   `<svg ${iconAttrs}><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`,
      dots:    `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
      dotsV:   `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`,
      chevron: `<svg ${iconAttrs}><polyline points="6 9 12 15 18 9"/></svg>`,
      addHome: `<svg ${iconAttrs}><rect x="3" y="3" width="18" height="18" rx="3" ry="3"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
      dock:    `<svg ${iconAttrs}><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 14V8a6 6 0 0 1 12 0v6"/></svg>`,
    };

    const badge = (icon, label) =>
      `<span class="install-badge${label ? '' : ' install-badge--icon-only'}">${icon}${label ? ' ' + label : ''}</span>`;

    const badgeBlue = (label) =>
      `<span class="install-badge install-badge--blue">${label}</span>`;

    const step = (num, html) =>
      `<li class="install-step">
        <div class="install-step-num">${num}</div>
        <div class="install-step-text">${html}</div>
      </li>`;

    // ── SVG-иконки для информационных экранов ─────────────────────
    const safariIcon = `<svg width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="44" height="44" rx="11" fill="#e8f0fe"/>
      <circle cx="22" cy="22" r="11" stroke="#3478f6" stroke-width="1.8" fill="none"/>
      <line x1="22" y1="11" x2="22" y2="13.5" stroke="#3478f6" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="22" y1="30.5" x2="22" y2="33" stroke="#3478f6" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="11" y1="22" x2="13.5" y2="22" stroke="#3478f6" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="30.5" y1="22" x2="33" y2="22" stroke="#3478f6" stroke-width="1.8" stroke-linecap="round"/>
      <polygon points="22,16 25.5,26.5 22,24.5 18.5,26.5" fill="#3478f6" opacity="0.9"/>
      <circle cx="22" cy="22" r="1.4" fill="#3478f6"/>
    </svg>`;

    const warningIcon = `<svg width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="44" height="44" rx="11" fill="#fef3c7"/>
      <path d="M22 14l8.5 15H13.5L22 14z" stroke="#d97706" stroke-width="1.8" stroke-linejoin="round" fill="none"/>
      <line x1="22" y1="21" x2="22" y2="25" stroke="#d97706" stroke-width="2" stroke-linecap="round"/>
      <circle cx="22" cy="27.5" r="1" fill="#d97706"/>
    </svg>`;

    // ── Apple-устройство не в Safari → «Откройте в Safari» ─────────
    if (device.endsWith('-nosafari')) {
      document.title = 'Откройте в Safari';
      app.innerHTML = `
        <section class="install-screen">
          <div class="install-card install-card--simple">
            <div class="install-simple-icon" aria-hidden="true">${safariIcon}</div>
            <h1 class="install-title">Откройте в Safari</h1>
            <p class="install-sub" style="margin-bottom:0">Абрис лучше всего работает в Safari — только через него можно добавить приложение на экран Домой</p>
            <button class="auth-next js-install-copy" type="button" style="margin-top:24px">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span class="js-install-copy-text">Скопировать ссылку</span>
            </button>
          </div>
        </section>`;
      const btn = app.querySelector('.js-install-copy');
      const txt = app.querySelector('.js-install-copy-text');
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(location.href).then(() => {
          txt.textContent = 'Скопировано!';
          btn.style.opacity = '0.7';
          setTimeout(() => { txt.textContent = 'Скопировать ссылку'; btn.style.opacity = ''; }, 2200);
        }).catch(() => {});
      });
      return;
    }

    // ── Android → инструкция по установке PWA ──────────────────────
    if (device === 'android') {
      document.title = 'Установите Абрис';
      const androidSteps = [
        step(1, `Нажмите ${badge(icons.dotsV)} в правом верхнем углу браузера`),
        step(2, `Выберите «Установить приложение» или «Добавить на главный экран»`),
        step(3, `Нажмите ${badgeBlue('Установить')}`),
      ];
      app.innerHTML = `
        <section class="install-screen">
          <div class="install-card">
            <div class="auth-logo" aria-hidden="true">${logoSVG}</div>
            <h1 class="install-title">Установите Абрис</h1>
            <ol class="install-steps">${androidSteps.join('')}</ol>
            <p class="install-note">Абрис разрабатывался для iPhone — если он у вас есть, лучше используйте его</p>
          </div>
        </section>`;
      return;
    }

    // ── Windows, Linux и другие ПК ──────────────────────────────────
    if (device === 'windows' || device === 'other') {
      document.title = 'Абрис — для мобильных';
      app.innerHTML = `
        <section class="install-screen">
          <div class="install-card install-card--simple">
            <div class="install-simple-icon" aria-hidden="true">${warningIcon}</div>
            <h1 class="install-title">Абрис для мобильных</h1>
            <p class="install-sub" style="margin-bottom:0">Приложение не тестировалось на Windows и Linux — возможна некорректная работа. Если есть iPhone или iPad, откройте Абрис в Safari на нём. Подойдёт и Android-смартфон.</p>
          </div>
        </section>`;
      return;
    }
    // ───────────────────────────────────────────────────────────────

    let steps = [];
    let arrowClass = '';
    let subText = '';

    if (device === 'iphone') {
      arrowClass = 'install-arrow--bottom';
      subText = 'Чтобы продолжить, добавьте приложение на экран Домой';
      steps = [
        step(1, `Нажмите ${badge(icons.dots)} в правом нижнем углу`),
        step(2, `Нажмите ${badge(icons.share, 'Поделиться')}`),
        step(3, `Прокрутите вниз и нажмите ${badge(icons.chevron, 'Показать ещё')}`),
        step(4, `Выберите ${badge(icons.addHome, 'Добавить на экран Домой')}`),
        step(5, `Нажмите ${badgeBlue('Добавить')} вверху справа`),
      ];
    } else if (device === 'ipad') {
      arrowClass = 'install-arrow--top';
      subText = 'Чтобы продолжить, добавьте приложение на экран Домой';
      steps = [
        step(1, `Нажмите ${badge(icons.share, 'Поделиться')} в панели Safari`),
        step(2, `Прокрутите вниз и нажмите ${badge(icons.chevron, 'Показать ещё')}`),
        step(3, `Выберите ${badge(icons.addHome, 'Добавить на экран Домой')}`),
        step(4, `Нажмите ${badgeBlue('Добавить')} вверху справа`),
      ];
    } else {
      // mac
      arrowClass = 'install-arrow--top-mac';
      subText = 'Чтобы продолжить, добавьте приложение в Dock';
      steps = [
        step(1, `Нажмите ${badge(icons.share, 'Поделиться')} в панели Safari`),
        step(2, `Выберите ${badge(icons.dock, 'Добавить в Dock')}`),
        step(3, `Нажмите ${badgeBlue('Добавить')}`),
      ];
    }

    const arrowSVG = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>`;

    const arrowSVGUp = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="18 15 12 9 6 15"/>
    </svg>`;

    const arrowMarkup = arrowClass === 'install-arrow--bottom' ? arrowSVG : arrowSVGUp;

    app.innerHTML = `
      <section class="install-screen">
        <div class="install-card">
          <div class="auth-logo" aria-hidden="true">${logoSVG}</div>
          <h1 class="install-title">Установите Абрис</h1>
          <ol class="install-steps">
            ${steps.join('')}
          </ol>
        </div>
        <div class="install-arrow ${arrowClass}" aria-hidden="true">
          ${arrowMarkup}
        </div>
      </section>`;
  };

  // ---------- Синхронизация статей ----------
  const syncArticles = async (db) => {
    let serverIndex;
    try {
      const res = await fetch('articles/index.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      serverIndex = await res.json();
    } catch (e) {
      return false; // офлайн или ошибка — ничего не меняем
    }

    // index.json — просто массив ID: ["id1", "id2", ...]
    const serverIds = new Set(serverIndex);

    const localArticles = await dbGetAll(db);
    const localMap = new Map(localArticles.map(a => [a.id, a]));

    // Удалить из IndexedDB статьи, которых больше нет на сервере
    let changed = false;
    for (const id of localMap.keys()) {
      if (!serverIds.has(id)) {
        await dbDelete(db, id);
        localMap.delete(id);
        changed = true;
      }
    }

    // Скачать новые статьи (которых нет в IndexedDB)
    const toFetch = serverIndex.filter(id => !localMap.has(id));
    await Promise.all(toFetch.map(async (id) => {
      try {
        let article;
        if (REQUIRE_ENCRYPTION) {
          const res = await fetch(`articles/${id}.enc`, { cache: 'no-store' });
          if (!res.ok) throw new Error(res.status);
          article = await decryptArticle(await res.arrayBuffer());
        } else {
          const res = await fetch(`articles/${id}.json`, { cache: 'no-store' });
          if (!res.ok) throw new Error(res.status);
          article = await res.json();
        }
        await dbPut(db, article);
        localMap.set(article.id, article);
        changed = true;
      } catch (e) { console.warn(`[sync] Ошибка статьи ${id}:`, e); }
    }));

    return changed;
  };

  // ---------- Анимация обновления ----------
  const triggerUpdate = (oldVersion, newVersion) => {
    const logoSVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <style>
        .al-bg { fill: #f2e0ce; } .al-s { stroke: #a83318; }
        @media (prefers-color-scheme: dark) { .al-bg { fill: #1a1a1f; } .al-s { stroke: #e87a4f; } }
      </style>
      <rect class="al-bg" width="100" height="100"/>
      <g class="al-s" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" fill="none">
        <line x1="50" y1="17" x2="13" y2="83"/>
        <line x1="50" y1="17" x2="87" y2="83"/>
        <line x1="28" y1="56" x2="72" y2="56"/>
      </g>
    </svg>`;

    const versionHTML = (oldVersion && newVersion)
      ? `<div class="update-version" aria-label="${oldVersion} → ${newVersion}">
           <span class="update-version-old" aria-hidden="true">${oldVersion}</span>
           <span class="update-version-arrow" aria-hidden="true">→</span>
           <span class="update-version-new" aria-hidden="true">${newVersion}</span>
         </div>`
      : '';

    const overlay = document.createElement('div');
    overlay.className = 'update-overlay';
    overlay.innerHTML = `
      <div class="update-overlay-logo" aria-hidden="true">${logoSVG}</div>
      <h2 class="update-overlay-title">Обновление</h2>
      ${versionHTML}
      <div class="update-progress" role="progressbar">
        <div class="update-progress-fill"></div>
      </div>`;
    document.body.appendChild(overlay);

    setTimeout(() => location.reload(), 3100);
  };

  // Консольные команды для тестирования
  window.__abrisUpdate    = triggerUpdate;
  window.__abrisOnboarding = () => {
    localStorage.removeItem(ONBOARDING_KEY);
    renderOnboarding(() => { markOnboardingDone(); window.location.reload(); });
  };
  window.__abrisSkeleton = () => { indexedDB.deleteDatabase(DB_NAME); location.reload(); };

  // ---------- Старт ----------
  const route = () => {
    if (REQUIRE_PWA && !isPWA()) {
      const device = detectDevice();
      if (device) { renderInstall(device); return; }
    }
    if (!isAuthorized()) {
      renderAuth();
      return;
    }
    const r = parseRoute();
    if (r.name === 'article') {
      renderArticle(r.id);
    } else {
      document.title = 'Абрис';
      renderList();
    }
  };

  window.addEventListener('hashchange', route);

  // Инициализация: загрузить из IndexedDB → отрисовать → синхронизировать с сервером
  openDB().then(async (db) => {
    appDb = db;
    // 1. Загрузить кэшированные статьи из IndexedDB
    const cached = await dbGetAll(db);
    window.NEWS = cached.length > 0 ? cached : [];

    // Если уже есть статьи — скелетон не нужен
    const wasEmpty = cached.length === 0;
    if (!wasEmpty) articlesLoaded = true;

    // Если авторизован в боевом режиме — восстанавливаем master_key
    if (REQUIRE_ENCRYPTION && isAuthorized()) {
      const deviceId = localStorage.getItem(AUTH_DEVICE_KEY);
      const password = localStorage.getItem(AUTH_PASSWORD_KEY);
      if (deviceId && password) {
        try {
          masterKey = await loadMasterKey(deviceId, password);
        } catch (e) {
          // Офлайн или enrollment удалён — продолжаем без masterKey
          // Статьи из IndexedDB всё равно покажем (они уже расшифрованы)
        }
      }
    }

    // 2. Первый рендер (из кэша или скелетон если пусто)
    route();

    // 3. Синхронизация с сервером в фоне
    const canSync = !REQUIRE_ENCRYPTION || masterKey !== null;
    const changed = canSync ? await syncArticles(db) : false;

    // Снять скелетон и обновить список
    articlesLoaded = true;
    if (changed) window.NEWS = await dbGetAll(db);
    if (changed || wasEmpty) {
      const r = parseRoute();
      if (r.name === 'list') {
        const cardsRoot = document.querySelector('.cards');
        if (cardsRoot) renderCards(cardsRoot);
      }
    }

    // Проверка версии приложения (и затем каждые 5 часов)
    await checkVersion();
    setInterval(checkVersion, AUTO_REFRESH_INTERVAL);
  }).catch((err) => {
    // IndexedDB недоступна
    console.warn('IndexedDB unavailable:', err);
    articlesLoaded = true;
    window.NEWS = window.NEWS || [];
    route();
  });
})();
