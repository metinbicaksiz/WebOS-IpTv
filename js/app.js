(function () {
  var STORAGE_CREDS = 'iptv_credentials';
  var STORAGE_FAVS = 'iptv_favorites';

  var TAB_LABELS = {
    live: 'LIVE TV',
    movies: 'MOVIES',
    series: 'SERIES',
    favorites: 'FAVORITES',
    search: 'SEARCH'
  };

  var els = {
    screens: {
      login: document.getElementById('screen-login'),
      menu: document.getElementById('screen-menu'),
      home: document.getElementById('screen-home'),
      series: document.getElementById('screen-series')
    },
    loginUrl: document.getElementById('login-url'),
    loginUser: document.getElementById('login-user'),
    loginPass: document.getElementById('login-pass'),
    loginBtn: document.getElementById('login-btn'),
    loginError: document.getElementById('login-error'),
    loginStatus: document.getElementById('login-status'),
    menuLogoutBtn: document.getElementById('menu-logout-btn'),
    menuRefreshBtn: document.getElementById('menu-refresh-btn'),
    menuTiles: document.querySelectorAll('.menu-tile'),
    browseBack: document.getElementById('browse-back'),
    browseTitle: document.getElementById('browse-title'),
    searchInput: document.getElementById('search-input'),
    categoryList: document.getElementById('category-list'),
    itemList: document.getElementById('item-list'),
    previewVideoWrap: document.getElementById('preview-video-wrap'),
    previewPoster: document.getElementById('preview-poster'),
    previewEmpty: document.getElementById('preview-empty'),
    previewInfo: document.getElementById('preview-info'),
    previewName: document.getElementById('preview-name'),
    previewStatus: document.getElementById('preview-status'),
    previewFavBtn: document.getElementById('preview-fav-btn'),
    seriesBack: document.getElementById('series-back'),
    seriesTitle: document.getElementById('series-title'),
    seasonList: document.getElementById('season-list'),
    episodeList: document.getElementById('episode-list'),
    playerOverlay: document.getElementById('player-overlay'),
    playerTitle: document.getElementById('player-title'),
    playerStatus: document.getElementById('player-status')
  };

  // Single shared <video> element, which stays physically parked inside the
  // small preview box for its entire life. Moving a <video> node between
  // containers turns out to reset webOS's native playback pipeline even
  // when .src is never touched (the connection silently drops and a fresh
  // one has to be renegotiated). "Fullscreen" is instead achieved with the
  // browser's native Fullscreen API on #preview-video-wrap — webOS's
  // hardware video overlay only reliably shows a picture when the video is
  // promoted that way; a manual CSS position:fixed trick left the video
  // playing (audio worked) but the picture stuck black.
  els.video = document.createElement('video');
  els.video.id = 'video';
  els.video.autoplay = true;
  els.previewVideoWrap.appendChild(els.video);

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  }
  // Returns the transition promise when the platform provides one, so
  // callers can wait for fullscreen to actually be established before
  // starting playback — the hardware video overlay is more likely to bind
  // to the right geometry if it isn't still promoted mid-transition.
  function requestFullscreen(el) {
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen || el.msRequestFullscreen;
    if (!fn) return null;
    var result = fn.call(el);
    return (result && result.then) ? result : null;
  }
  function exitFullscreenApi() {
    if (!isFullscreen()) return;
    var fn = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen || document.msExitFullscreen;
    if (fn) fn.call(document);
  }

  var state = {
    currentTab: 'live',
    currentCategoryId: null,
    cache: emptyCache(),
    seriesInfo: {},
    favorites: [],
    currentSeries: null,
    returnScreen: 'menu',
    overlayTimer: null,
    playbackUrl: null,
    retryCount: 0,
    retryTimer: null,
    previewItem: null,
    previewPlaying: null,
    // Bumped on every start/stop so a slot-wait or retry left over from a
    // previous stream can never open a second connection.
    playbackToken: 0,
    stallTimer: null,
    liveFormat: 'ts'
  };
  try { state.liveFormat = localStorage.getItem(STORAGE_LIVE_FORMAT) || 'ts'; } catch (e) {}

  // Live channels play as MPEG-TS, like the desktop IPTV Stream Player: one
  // continuous connection that the provider releases the moment it's
  // closed, so switching channels doesn't run into the one-connection
  // limit. HLS is only used if this TV turns out not to play TS.
  var STORAGE_LIVE_FORMAT = 'iptv_live_format';

  // If a new stream is still rejected (e.g. another device is using the
  // account), retry with backoff instead of failing immediately.
  var RETRY_DELAYS_MS = [3000, 5000, 8000, 12000, 16000, 20000];

  // A provider that's out of slots often just holds the request open
  // without answering. Give up on such a connection quickly so it can't
  // occupy the slot itself, then retry.
  var STALL_TIMEOUT_MS = 12000;

  // Like the desktop IPTV Stream Player, the catalog is downloaded once
  // (one request per list, not one per category) and reused across
  // launches until it's refreshed from the main menu.
  var STORAGE_CATALOG = 'iptv_catalog_';
  var CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  // ---------- Screen management ----------
  function showScreen(name) {
    Object.keys(els.screens).forEach(function (key) {
      els.screens[key].classList.toggle('active', key === name);
    });
    setTimeout(function () { Nav.focusFirst(els.screens[name]); }, 30);
  }

  // ---------- Favorites ----------
  function loadFavorites() {
    try {
      state.favorites = JSON.parse(localStorage.getItem(STORAGE_FAVS)) || [];
    } catch (e) { state.favorites = []; }
  }
  function saveFavorites() {
    localStorage.setItem(STORAGE_FAVS, JSON.stringify(state.favorites));
  }
  function favKey(type, id) { return type + ':' + id; }
  function isFavorite(type, id) {
    var k = favKey(type, id);
    return state.favorites.some(function (f) { return favKey(f.type, f.id) === k; });
  }
  function toggleFavorite(item) {
    var k = favKey(item.type, item.id);
    var idx = state.favorites.findIndex(function (f) { return favKey(f.type, f.id) === k; });
    if (idx >= 0) state.favorites.splice(idx, 1);
    else state.favorites.push(item);
    saveFavorites();
  }

  // ---------- Login ----------
  function loadCreds() {
    try { return JSON.parse(localStorage.getItem(STORAGE_CREDS)); } catch (e) { return null; }
  }
  function saveCreds(url, user, pass) {
    localStorage.setItem(STORAGE_CREDS, JSON.stringify({ url: url, user: user, pass: pass }));
  }

  function doLogin(url, user, pass, silent) {
    els.loginError.textContent = '';
    els.loginStatus.textContent = 'Signing in...';
    Xtream.configure(url, user, pass);
    Xtream.authenticate().then(function () {
      saveCreds(url, user, pass);
      els.loginStatus.textContent = '';
      resetCache();
      loadFavorites();
      showScreen('menu');
    }).catch(function (err) {
      els.loginStatus.textContent = '';
      els.loginError.textContent = 'Login failed: ' + (err && err.message ? err.message : 'check your details');
      if (!silent) Nav.focusFirst(els.screens.login);
    });
  }

  els.loginBtn.addEventListener('click', function () {
    doLogin(els.loginUrl.value, els.loginUser.value, els.loginPass.value, false);
  });

  // Each tab's catalog: categories plus every item grouped by category_id,
  // so switching categories or searching never touches the network.
  function emptyCache() {
    return { live: null, movies: null, series: null };
  }

  function resetCache() {
    state.cache = emptyCache();
    state.seriesInfo = {};
  }

  function clearStoredCatalogs() {
    ['live', 'movies', 'series'].forEach(function (tab) {
      try { localStorage.removeItem(STORAGE_CATALOG + tab); } catch (e) {}
    });
  }

  function doLogout() {
    stopPlayback();
    resetCache();
    clearStoredCatalogs();
    localStorage.removeItem(STORAGE_CREDS);
    els.loginUrl.value = '';
    els.loginUser.value = '';
    els.loginPass.value = '';
    showScreen('login');
  }
  els.menuLogoutBtn.addEventListener('click', doLogout);
  els.menuRefreshBtn.addEventListener('click', function () {
    resetCache();
    clearStoredCatalogs();
    els.menuRefreshBtn.textContent = 'Catalog cleared — reloads on open';
    setTimeout(function () { els.menuRefreshBtn.textContent = 'Refresh catalog'; }, 3000);
  });

  // ---------- Main menu ----------
  els.menuTiles.forEach(function (tile) {
    tile.addEventListener('click', function () { enterBrowse(tile.dataset.target); });
    tile.addEventListener('keydown', function (e) {
      if (e.keyCode === KEYS.ENTER) enterBrowse(tile.dataset.target);
    });
  });

  function enterBrowse(tabName) {
    showScreen('home');
    selectTab(tabName);
  }

  els.browseBack.addEventListener('click', function () {
    stopPreview();
    showScreen('menu');
  });

  // ---------- Tabs / browse ----------
  function selectTab(tabName) {
    state.currentTab = tabName;
    state.currentCategoryId = null;
    els.browseTitle.textContent = TAB_LABELS[tabName] || '';
    els.searchInput.classList.toggle('visible', tabName === 'search');
    els.categoryList.innerHTML = '';
    els.itemList.innerHTML = '';
    renderPreviewEmpty();

    if (tabName === 'favorites') {
      renderFavorites();
      return;
    }
    if (tabName === 'search') {
      els.searchInput.value = '';
      renderMessage('Type to search across live TV, movies and series.');
      preloadAllForSearch();
      return;
    }
    loadCategories(tabName);
  }

  function renderMessage(msg) {
    els.itemList.innerHTML = '<div class="empty-msg"></div>';
    els.itemList.firstChild.textContent = msg;
  }

  // ---------- Catalog (downloaded once, then cached) ----------
  var CATALOG_FETCHERS = {
    live: { type: 'live', categories: function () { return Xtream.getLiveCategories(); }, items: function () { return Xtream.getLiveStreams(); } },
    movies: { type: 'movie', categories: function () { return Xtream.getVodCategories(); }, items: function () { return Xtream.getVodStreams(); } },
    series: { type: 'series', categories: function () { return Xtream.getSeriesCategories(); }, items: function () { return Xtream.getSeries(); } }
  };
  var catalogLoads = {};

  function catalogOwner() {
    var creds = loadCreds() || {};
    return (creds.url || '') + '|' + (creds.user || '');
  }

  function readStoredCatalog(tab) {
    try {
      var stored = JSON.parse(localStorage.getItem(STORAGE_CATALOG + tab));
      if (stored && stored.owner === catalogOwner() && Date.now() - stored.savedAt < CATALOG_MAX_AGE_MS) {
        return stored.catalog;
      }
    } catch (e) {}
    return null;
  }

  function writeStoredCatalog(tab, catalog) {
    // Large provider lists can exceed the TV's storage quota; the catalog
    // then simply lives in memory for this session.
    try {
      localStorage.setItem(STORAGE_CATALOG + tab, JSON.stringify({
        owner: catalogOwner(), savedAt: Date.now(), catalog: catalog
      }));
    } catch (e) {
      try { localStorage.removeItem(STORAGE_CATALOG + tab); } catch (e2) {}
    }
  }

  function loadCatalog(tab) {
    if (state.cache[tab]) return Promise.resolve(state.cache[tab]);
    var stored = readStoredCatalog(tab);
    if (stored) {
      state.cache[tab] = stored;
      return Promise.resolve(stored);
    }
    if (catalogLoads[tab]) return catalogLoads[tab];
    var f = CATALOG_FETCHERS[tab];
    var categories;
    // Requests run one after another (Xtream queues them anyway).
    catalogLoads[tab] = f.categories().then(function (cats) {
      categories = (cats || []).map(function (c) {
        return { category_id: c.category_id, category_name: c.category_name };
      });
      return f.items();
    }).then(function (rawItems) {
      var byCategory = {};
      var all = (rawItems || []).map(function (raw) {
        var item = normalizeItem(raw, f.type);
        var key = String(raw.category_id);
        (byCategory[key] = byCategory[key] || []).push(item);
        return item;
      });
      var catalog = { categories: categories, byCategory: byCategory, all: all };
      state.cache[tab] = catalog;
      writeStoredCatalog(tab, catalog);
      return catalog;
    });
    var clear = function () { delete catalogLoads[tab]; };
    catalogLoads[tab].then(clear, clear);
    return catalogLoads[tab];
  }

  // ---------- Categories ----------
  function loadCategories(tabName) {
    renderMessage('Loading ' + (TAB_LABELS[tabName] || '').toLowerCase() + '...');
    loadCatalog(tabName).then(function (catalog) {
      if (state.currentTab !== tabName) return;
      renderCategories(catalog.categories);
      if (catalog.categories.length) {
        selectCategory(tabName, catalog.categories[0].category_id, catalog.categories[0].category_name);
      } else {
        renderMessage('No categories found.');
      }
    }).catch(function (err) {
      if (state.currentTab === tabName) renderMessage('Failed to load: ' + err.message);
    });
  }

  function renderCategories(cats) {
    els.categoryList.innerHTML = '';
    cats.forEach(function (cat) {
      var div = document.createElement('div');
      div.className = 'category-item focusable';
      div.tabIndex = 0;
      div.textContent = cat.category_name;
      div.addEventListener('click', function () { selectCategory(state.currentTab, cat.category_id, cat.category_name); });
      div.addEventListener('keydown', function (e) {
        if (e.keyCode === KEYS.ENTER) selectCategory(state.currentTab, cat.category_id, cat.category_name);
      });
      div._categoryId = cat.category_id;
      els.categoryList.appendChild(div);
    });
  }

  function markActiveCategory(categoryId) {
    Array.prototype.forEach.call(els.categoryList.children, function (el) {
      el.classList.toggle('active', String(el._categoryId) === String(categoryId));
    });
  }

  function selectCategory(tabName, categoryId, categoryName) {
    var catalog = state.cache[tabName];
    if (!catalog) return;
    state.currentCategoryId = categoryId;
    markActiveCategory(categoryId);
    if (categoryName === undefined) {
      var cat = catalog.categories.filter(function (c) { return String(c.category_id) === String(categoryId); })[0];
      categoryName = cat && cat.category_name;
    }
    els.browseTitle.textContent = (TAB_LABELS[tabName] || '') + (categoryName ? ' | ' + categoryName : '');
    renderItems(catalog.byCategory[String(categoryId)] || []);
  }

  // ---------- Items list ----------
  function normalizeItem(raw, type) {
    if (type === 'live') {
      return { type: 'live', id: raw.stream_id, name: raw.name, icon: raw.stream_icon };
    }
    if (type === 'movie') {
      return { type: 'movie', id: raw.stream_id, name: raw.name, icon: raw.stream_icon, ext: raw.container_extension };
    }
    return { type: 'series', id: raw.series_id, name: raw.name, icon: raw.cover };
  }

  function renderItems(items) {
    els.itemList.innerHTML = '';
    if (!items || !items.length) {
      renderMessage('No items in this category.');
      return;
    }
    items.forEach(function (item) {
      els.itemList.appendChild(buildItemRow(item));
    });
  }

  function buildItemRow(item) {
    var row = document.createElement('div');
    row.className = 'item-row focusable';
    row.tabIndex = 0;
    // webOS's WAM webview does not reliably fire native 'focus' events for
    // remote-driven focus changes, so Nav's keydown handler reads this back
    // explicitly instead of relying on addEventListener('focus', ...).
    row._previewItem = item;

    var img = document.createElement('img');
    img.src = item.icon || '';
    img.onerror = function () { img.style.visibility = 'hidden'; };
    row.appendChild(img);

    var name = document.createElement('div');
    name.className = 'item-row-name';
    name.textContent = item.name;
    row.appendChild(name);

    if (isFavorite(item.type, item.id)) {
      var badge = document.createElement('div');
      badge.className = 'fav-badge';
      badge.textContent = '★';
      row.appendChild(badge);
    }

    row.addEventListener('click', function () { activateItem(item); });
    row.addEventListener('keydown', function (e) {
      if (e.keyCode === KEYS.ENTER) {
        // activateItem() can synchronously switch to the fullscreen player
        // and resume playback. If this same keydown were left to bubble up
        // to the document-level handler, it would see the player screen as
        // already active and reinterpret the very same OK press as "toggle
        // play/pause" — immediately pausing the video it had just resumed.
        e.stopPropagation();
        activateItem(item);
      }
      if (e.keyCode === KEYS.GREEN) {
        e.stopPropagation();
        toggleFavorite(item);
        rerenderCurrent();
        if (state.previewItem === item) updatePreviewInfo(item);
      }
    });
    return row;
  }

  function rerenderCurrent() {
    if (state.currentTab === 'favorites') renderFavorites();
    else if (state.currentCategoryId != null) selectCategory(state.currentTab, state.currentCategoryId);
  }

  function activateItem(item) {
    if (item.type === 'series') {
      openSeries(item);
    } else if (item.type === 'live' && !isPreviewing(item)) {
      // First OK plays the channel in the preview box; a second OK on the
      // same channel goes fullscreen.
      startPreview(item);
    } else {
      playItem(item);
    }
  }

  // ---------- Favorites tab ----------
  function renderFavorites() {
    els.categoryList.innerHTML = '';
    if (!state.favorites.length) {
      renderMessage('No favorites yet. Select an item and press the GREEN key to add one.');
      return;
    }
    els.itemList.innerHTML = '';
    state.favorites.forEach(function (item) {
      els.itemList.appendChild(buildItemRow(item));
    });
  }

  // ---------- Search ----------
  function preloadAllForSearch() {
    // Sequential, and each list is only ever downloaded once.
    loadCatalog('live').catch(function () {})
      .then(function () { return loadCatalog('movies').catch(function () {}); })
      .then(function () { return loadCatalog('series').catch(function () {}); })
      .then(function () {
        if (state.currentTab === 'search') runSearch(els.searchInput.value);
      });
  }

  function runSearch(query) {
    query = query.trim().toLowerCase();
    if (!query) { renderMessage('Type to search across live TV, movies and series.'); return; }
    var pools = ['live', 'movies', 'series'].map(function (tab) { return state.cache[tab] && state.cache[tab].all; });
    var results = [];
    pools.forEach(function (pool) {
      if (!pool) return;
      pool.forEach(function (item) {
        if (item.name && item.name.toLowerCase().indexOf(query) !== -1) results.push(item);
      });
    });
    els.itemList.innerHTML = '';
    if (!results.length) { renderMessage('No results.'); return; }
    results.slice(0, 200).forEach(function (item) {
      els.itemList.appendChild(buildItemRow(item));
    });
  }

  els.searchInput.addEventListener('input', function () { runSearch(els.searchInput.value); });

  // ---------- Preview panel ----------
  // The preview never starts on its own: on a single-connection account an
  // auto-playing preview would grab the only slot just from scrolling. It
  // plays only after OK, and moving focus away releases it again.
  function updatePreviewInfo(item) {
    els.previewInfo.classList.add('active');
    els.previewName.textContent = item.name;
    var fav = isFavorite(item.type, item.id);
    els.previewFavBtn.classList.toggle('active', fav);
    els.previewFavBtn.textContent = fav ? '♥ Favorited' : '♡ Favorite';
  }

  function renderPreviewEmpty() {
    stopPreview();
    els.previewVideoWrap.classList.remove('active');
    els.previewPoster.classList.remove('active');
    els.previewInfo.classList.remove('active');
    els.previewEmpty.classList.add('active');
    els.previewStatus.textContent = '';
    state.previewItem = null;
  }

  function focusPreview(item) {
    if (state.previewPlaying && !isPreviewing(item)) stopPreview();
    els.previewEmpty.classList.remove('active');
    els.previewVideoWrap.classList.add('active');
    els.previewPoster.classList.add('active');
    els.previewPoster.style.visibility = '';
    els.previewPoster.src = item.icon || '';
    els.previewPoster.onerror = function () { els.previewPoster.style.visibility = 'hidden'; };
    els.previewStatus.textContent = item.type === 'series' ? 'Press OK to open'
      : item.type === 'live' ? 'Press OK to preview' : 'Press OK to watch';
    state.previewItem = item;
    updatePreviewInfo(item);
  }

  // Compared by id: favorites/search rows hold their own copies of an item.
  function isPreviewing(item) {
    var p = state.previewPlaying;
    return !!p && p.type === item.type && String(p.id) === String(item.id);
  }

  function startPreview(item) {
    closeStream();
    var token = ++state.playbackToken;
    state.playbackUrl = Xtream.liveStreamUrl(item.id, state.liveFormat);
    state.previewPlaying = item;
    state.retryCount = 0;
    els.previewPoster.classList.remove('active');
    els.previewStatus.textContent = 'Loading preview...';
    openStream(token);
  }

  function stopPreview() {
    if (!state.previewPlaying || isFullscreen()) return;
    stopPlayback();
    els.previewPoster.classList.add('active');
  }

  els.previewFavBtn.addEventListener('click', function () {
    if (!state.previewItem) return;
    toggleFavorite(state.previewItem);
    updatePreviewInfo(state.previewItem);
    rerenderCurrent();
  });
  els.previewFavBtn.addEventListener('keydown', function (e) {
    if (e.keyCode === KEYS.ENTER) els.previewFavBtn.click();
  });

  // ---------- Series detail ----------
  function openSeries(item) {
    stopPreview();
    state.currentSeries = item;
    els.seriesTitle.textContent = item.name;
    els.seasonList.innerHTML = '';
    els.episodeList.innerHTML = '';
    showScreen('series');
    var infoPromise = state.seriesInfo[item.id]
      ? Promise.resolve(state.seriesInfo[item.id])
      : Xtream.getSeriesInfo(item.id).then(function (data) {
        state.seriesInfo[item.id] = data;
        return data;
      });
    infoPromise.then(function (data) {
      if (state.currentSeries !== item) return;
      var episodesBySeason = (data && data.episodes) || {};
      var seasonNums = Object.keys(episodesBySeason).sort(function (a, b) { return Number(a) - Number(b); });
      if (!seasonNums.length) {
        els.episodeList.innerHTML = '<div class="empty-msg">No episodes found.</div>';
        return;
      }
      seasonNums.forEach(function (num, idx) {
        var div = document.createElement('div');
        div.className = 'category-item focusable';
        div.tabIndex = 0;
        div.textContent = 'Season ' + num;
        div.addEventListener('click', function () { renderEpisodes(episodesBySeason[num]); });
        div.addEventListener('keydown', function (e) {
          if (e.keyCode === KEYS.ENTER) renderEpisodes(episodesBySeason[num]);
        });
        els.seasonList.appendChild(div);
        if (idx === 0) renderEpisodes(episodesBySeason[num]);
      });
    }).catch(function (err) {
      els.episodeList.innerHTML = '<div class="empty-msg">Failed to load: ' + err.message + '</div>';
    });
  }

  function renderEpisodes(episodes) {
    els.episodeList.innerHTML = '';
    (episodes || []).forEach(function (ep) {
      var div = document.createElement('div');
      div.className = 'episode-item focusable';
      div.tabIndex = 0;
      div.textContent = (ep.episode_num ? ep.episode_num + '. ' : '') + (ep.title || 'Episode');
      div.addEventListener('click', function () { playEpisode(ep); });
      div.addEventListener('keydown', function (e) {
        if (e.keyCode === KEYS.ENTER) {
          // See the item-row ENTER handler for why this must not bubble.
          e.stopPropagation();
          playEpisode(ep);
        }
      });
      els.episodeList.appendChild(div);
    });
  }

  function playEpisode(ep) {
    var url = Xtream.seriesEpisodeUrl(ep.id, ep.container_extension);
    state.returnScreen = 'series';
    startPlayback(url, ep.title || 'Episode');
  }

  els.seriesBack.addEventListener('click', function () { showScreen('home'); });

  // ---------- Player ----------
  // webOS renders live video through a hardware overlay plane that only
  // reliably binds its picture to the element's on-screen size when
  // playback (re)starts fresh — resizing an already-playing video via CSS
  // (even a pause/resume nudge without touching .src) leaves the audio
  // playing but the picture stuck black. So entering fullscreen always goes
  // through a genuine (re)connect, sized fullscreen from the start, rather
  // than trying to hand off an already-playing preview in place.
  function playItem(item) {
    state.returnScreen = 'home';
    var url = item.type === 'live' ? Xtream.liveStreamUrl(item.id, state.liveFormat) : Xtream.vodStreamUrl(item.id, item.ext);
    startPlayback(url, item.name);
  }

  function enterFullscreen(title, onReady) {
    // #preview-video-wrap physically lives inside #screen-home, so that
    // screen must be the active one (not display:none) for the element to
    // have a real layout box — requestFullscreen() on a 0x0 element fails
    // silently. There's no separate "player screen": the Fullscreen API's
    // own top-layer rendering is what actually covers everything else,
    // regardless of which screen is nominally active underneath.
    showScreen('home');
    // The item row that was pressed keeps DOM focus (entering fullscreen
    // doesn't move it) and its own keydown handler intercepts ENTER with
    // stopPropagation(). Left focused, a second ENTER meant to toggle
    // play/pause while already fullscreen would instead be swallowed by the
    // row and start yet another fresh connection. Blur it so subsequent key
    // presses reach this global handler instead.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    var fsPromise = requestFullscreen(els.previewVideoWrap);
    els.playerTitle.textContent = title || '';
    showOverlay();
    scheduleOverlayHide();
    if (fsPromise) fsPromise.then(onReady, onReady);
    else if (onReady) onReady();
  }

  // Status line for whichever view owns the stream right now.
  function setStreamStatus(text) {
    if (isFullscreen()) {
      els.playerStatus.textContent = text;
      showOverlay();
    } else {
      els.previewStatus.textContent = text;
    }
  }

  // Connects right away, as the desktop player does — with TS the previous
  // stream's slot is already free once closeStream() has run.
  function openStream(token) {
    if (token !== state.playbackToken) return;
    clearTimeout(state.stallTimer);
    els.video.src = state.playbackUrl;
    els.video.play().catch(function () {});
    state.stallTimer = setTimeout(function () {
      if (token === state.playbackToken) streamFailed(false);
    }, STALL_TIMEOUT_MS);
  }

  function streamFailed(unsupported) {
    // This TV can't play TS: switch live playback to HLS for good.
    if (unsupported && /\.ts$/.test(state.playbackUrl || '') && state.liveFormat === 'ts') {
      state.liveFormat = 'm3u8';
      try { localStorage.setItem(STORAGE_LIVE_FORMAT, 'm3u8'); } catch (e) {}
      state.playbackUrl = state.playbackUrl.replace(/\.ts$/, '.m3u8');
      closeStream();
      openStream(state.playbackToken);
      return;
    }
    if (isFullscreen() && state.playbackUrl) {
      retryPlayback();
    } else if (state.previewPlaying) {
      // No automatic retries for a preview — release the slot and let the
      // user decide with OK.
      stopPlayback();
      els.previewPoster.classList.add('active');
      els.previewStatus.textContent = 'Preview unavailable. Press OK to try again.';
    }
  }

  // Tears down the current stream, if any, so its slot starts being
  // released right away. Exactly one stream URL is ever assigned at a time.
  function closeStream() {
    clearTimeout(state.retryTimer);
    clearTimeout(state.stallTimer);
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
  }

  function startPlayback(url, title) {
    // Pressing OK again on what's already starting/playing must not open
    // another connection.
    if (state.playbackUrl === url && isFullscreen()) return;
    // Fullscreen needs a fresh connection (see above), so the preview's
    // stream is closed first and the slot wait covers its release.
    closeStream();
    state.previewPlaying = null;
    var token = ++state.playbackToken;
    state.playbackUrl = url;
    state.retryCount = 0;
    els.playerStatus.textContent = 'Loading...';
    enterFullscreen(title, function () {
      if (token === state.playbackToken) openStream(token);
    });
  }

  function retryPlayback() {
    closeStream();
    if (state.retryCount >= RETRY_DELAYS_MS.length) {
      els.playerStatus.textContent = 'Playback error. Your account allows only one connection ' +
        'at a time — make sure nothing else is using it, then press OK to retry.';
      showOverlay();
      return;
    }
    var token = state.playbackToken;
    var delay = RETRY_DELAYS_MS[state.retryCount];
    state.retryCount++;
    // Keep the first few retries looking like ordinary buffering — most of
    // the time the connection frees up quickly, and surfacing "connection
    // busy" language only once it's taking a while avoids alarming the user
    // over what is usually just a brief reconnect.
    els.playerStatus.textContent = state.retryCount <= 2
      ? 'Connecting...'
      : 'Still connecting… another device may be using your account\'s only connection.';
    showOverlay();
    state.retryTimer = setTimeout(function () {
      if (token === state.playbackToken) openStream(token);
    }, delay);
  }

  els.video.addEventListener('playing', function () {
    clearTimeout(state.stallTimer);
    if (!isFullscreen()) {
      if (state.previewPlaying) els.previewStatus.textContent = 'Press OK for fullscreen';
      return;
    }
    clearTimeout(state.retryTimer);
    state.retryCount = 0;
    els.playerStatus.textContent = '';
    scheduleOverlayHide();
  });
  els.video.addEventListener('waiting', function () {
    if (!isFullscreen()) {
      if (state.previewPlaying) els.previewStatus.textContent = 'Buffering...';
      return;
    }
    els.playerStatus.textContent = 'Buffering...';
    showOverlay();
  });
  els.video.addEventListener('error', function () {
    // Ignore errors from the empty src that closeStream() leaves behind.
    if (!els.video.getAttribute('src')) return;
    streamFailed(els.video.error && els.video.error.code === 4);
  });

  function showOverlay() {
    els.playerOverlay.classList.add('visible');
    clearTimeout(state.overlayTimer);
  }
  function scheduleOverlayHide() {
    clearTimeout(state.overlayTimer);
    state.overlayTimer = setTimeout(function () {
      els.playerOverlay.classList.remove('visible');
    }, 4000);
  }

  function stopPlayback() {
    state.playbackToken++;
    state.playbackUrl = null;
    state.previewPlaying = null;
    state.retryCount = 0;
    closeStream();
    els.playerOverlay.classList.remove('visible');
    exitFullscreenApi();
  }

  // If fullscreen is left any way other than BACK (e.g. the system takes it
  // away), the stream would otherwise keep its slot playing out of sight.
  function onFullscreenChange() {
    if (!isFullscreen() && state.playbackUrl) {
      stopPlayback();
      showScreen(state.returnScreen);
    }
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // Release the stream connection as soon as the app is backgrounded or
  // closed, since most Xtream providers cap simultaneous connections (often
  // to just 1) and only free the slot after the client stops requesting
  // segments — leaving a paused/open stream blocks all future playback.
  function releaseIfPlaying() {
    if (els.video.getAttribute('src') || state.playbackUrl) stopPlayback();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseIfPlaying();
  });
  window.addEventListener('pagehide', releaseIfPlaying);
  window.addEventListener('webOSRelaunch', releaseIfPlaying);

  // ---------- Global key handling ----------
  document.addEventListener('keydown', function (e) {
    var code = e.keyCode;

    if (isFullscreen()) {
      if (code === KEYS.BACK || code === KEYS.BACKSPACE) {
        e.preventDefault();
        stopPlayback();
        showScreen(state.returnScreen);
      } else if (code === KEYS.ENTER || code === KEYS.PLAY || code === KEYS.PAUSE) {
        if (state.playbackUrl && (els.video.error || !els.video.getAttribute('src'))) {
          // Manual retry after giving up (or while waiting for a slot).
          closeStream();
          state.retryCount = 0;
          els.playerStatus.textContent = 'Retrying...';
          showOverlay();
          openStream(++state.playbackToken);
        } else if (els.video.paused) {
          els.video.play();
        } else {
          els.video.pause();
        }
        showOverlay();
        scheduleOverlayHide();
      } else if ([KEYS.LEFT, KEYS.RIGHT, KEYS.UP, KEYS.DOWN].indexOf(code) !== -1) {
        showOverlay();
        scheduleOverlayHide();
      }
      return;
    }

    if (code === KEYS.BACK || code === KEYS.BACKSPACE) {
      if (els.screens.series.classList.contains('active')) {
        e.preventDefault();
        showScreen('home');
        return;
      }
      if (els.screens.home.classList.contains('active')) {
        e.preventDefault();
        stopPreview();
        showScreen('menu');
        return;
      }
      if (els.screens.menu.classList.contains('active')) {
        e.preventDefault();
        try { window.close(); } catch (err) {}
        return;
      }
      return;
    }

    var dirMap = {};
    dirMap[KEYS.LEFT] = 'left';
    dirMap[KEYS.RIGHT] = 'right';
    dirMap[KEYS.UP] = 'up';
    dirMap[KEYS.DOWN] = 'down';
    if (dirMap[code]) {
      var handled = Nav.move(dirMap[code]);
      if (handled !== false) e.preventDefault();
      checkFocusedPreview();
    }
  });

  function checkFocusedPreview() {
    var el = document.activeElement;
    if (el && el._previewItem && el._previewItem !== state.previewItem) {
      focusPreview(el._previewItem);
    }
  }

  // ---------- Init ----------
  function init() {
    loadFavorites();
    var creds = loadCreds();
    if (creds && creds.url && creds.user) {
      els.loginUrl.value = creds.url;
      els.loginUser.value = creds.user;
      els.loginPass.value = creds.pass || '';
      showScreen('login');
      doLogin(creds.url, creds.user, creds.pass, true);
    } else {
      showScreen('login');
    }
  }

  init();
})();
