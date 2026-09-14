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
      series: document.getElementById('screen-series'),
      player: document.getElementById('screen-player')
    },
    loginUrl: document.getElementById('login-url'),
    loginUser: document.getElementById('login-user'),
    loginPass: document.getElementById('login-pass'),
    loginBtn: document.getElementById('login-btn'),
    loginError: document.getElementById('login-error'),
    loginStatus: document.getElementById('login-status'),
    menuLogoutBtn: document.getElementById('menu-logout-btn'),
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
    videoHome: document.getElementById('video-home'),
    playerOverlay: document.getElementById('player-overlay'),
    playerTitle: document.getElementById('player-title'),
    playerStatus: document.getElementById('player-status')
  };

  // Single shared <video> element. It physically moves between the small
  // preview box, the fullscreen player, and this offscreen parking spot —
  // moving a <video> node in the DOM does not interrupt playback, which is
  // what lets a live preview hand off to fullscreen without reconnecting.
  els.video = document.createElement('video');
  els.video.id = 'video';
  els.video.autoplay = true;
  els.videoHome.appendChild(els.video);

  var state = {
    currentTab: 'live',
    currentCategoryId: null,
    cache: {
      live: { categories: null, streamsByCategory: {}, all: null },
      movies: { categories: null, streamsByCategory: {}, all: null },
      series: { categories: null, seriesByCategory: {}, all: null }
    },
    favorites: [],
    currentSeries: null,
    returnScreen: 'menu',
    overlayTimer: null,
    playbackUrl: null,
    retryCount: 0,
    retryTimer: null,
    previewTimer: null,
    previewItem: null,
    previewPlaying: null
  };

  // Providers commonly cap simultaneous connections (often to just 1) and
  // only release a slot ~45-90s after the client stops requesting data,
  // regardless of how promptly the app tears down its side. Switching
  // channels right after closing the previous one reliably hits this
  // window, so retry with backoff instead of failing immediately.
  var RETRY_DELAYS_MS = [4000, 8000, 12000, 16000, 20000, 20000, 20000, 20000];

  // Live preview only starts after focus rests on a channel for a moment —
  // browsing quickly through a list must not fire off a new stream
  // connection per row, or the account's single-connection limit would
  // make the list itself unusable.
  var PREVIEW_DEBOUNCE_MS = 1200;

  // ---------- Screen management ----------
  function showScreen(name) {
    Object.keys(els.screens).forEach(function (key) {
      els.screens[key].classList.toggle('active', key === name);
    });
    setTimeout(function () { Nav.focusFirst(els.screens[name]); }, 30);
  }

  // Like showScreen, but for transitions that also relocate the shared
  // <video> element. Some webOS TVs render video through a hardware overlay
  // tied to the element's layout box; if the video is ever reparented while
  // its container is display:none (even for one synchronous step), that
  // overlay can stall/reset and the stream gets stuck buffering even though
  // playback was fine right before. Making the destination screen visible
  // first, then moving the video, then hiding the old screen guarantees the
  // video always has a visible parent throughout the handoff.
  function showScreenWithVideo(name, moveVideoFn) {
    els.screens[name].classList.add('active');
    moveVideoFn();
    Object.keys(els.screens).forEach(function (key) {
      if (key !== name) els.screens[key].classList.remove('active');
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

  function resetCache() {
    state.cache = {
      live: { categories: null, streamsByCategory: {}, all: null },
      movies: { categories: null, streamsByCategory: {}, all: null },
      series: { categories: null, seriesByCategory: {}, all: null }
    };
  }

  function doLogout() {
    stopPreviewVideo();
    localStorage.removeItem(STORAGE_CREDS);
    els.loginUrl.value = '';
    els.loginUser.value = '';
    els.loginPass.value = '';
    showScreen('login');
  }
  els.menuLogoutBtn.addEventListener('click', doLogout);

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
    stopPreviewVideo();
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

  // ---------- Categories ----------
  function loadCategories(tabName) {
    var bucket = state.cache[tabName];
    var promise;
    if (bucket.categories) {
      promise = Promise.resolve(bucket.categories);
    } else if (tabName === 'live') {
      promise = Xtream.getLiveCategories();
    } else if (tabName === 'movies') {
      promise = Xtream.getVodCategories();
    } else {
      promise = Xtream.getSeriesCategories();
    }
    renderMessage('Loading...');
    promise.then(function (cats) {
      bucket.categories = cats || [];
      renderCategories(bucket.categories);
      if (bucket.categories.length) {
        selectCategory(tabName, bucket.categories[0].category_id, bucket.categories[0].category_name);
      } else {
        renderMessage('No categories found.');
      }
    }).catch(function (err) {
      renderMessage('Failed to load: ' + err.message);
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
    state.currentCategoryId = categoryId;
    markActiveCategory(categoryId);
    els.browseTitle.textContent = (TAB_LABELS[tabName] || '') + (categoryName ? ' | ' + categoryName : '');
    var bucket = state.cache[tabName];
    renderMessage('Loading...');

    if (tabName === 'live') {
      getOrFetch(bucket.streamsByCategory, categoryId, function () { return Xtream.getLiveStreams(categoryId); })
        .then(function (items) { renderItems(items, 'live'); })
        .catch(function (err) { renderMessage('Failed to load: ' + err.message); });
    } else if (tabName === 'movies') {
      getOrFetch(bucket.streamsByCategory, categoryId, function () { return Xtream.getVodStreams(categoryId); })
        .then(function (items) { renderItems(items, 'movie'); })
        .catch(function (err) { renderMessage('Failed to load: ' + err.message); });
    } else {
      getOrFetch(bucket.seriesByCategory, categoryId, function () { return Xtream.getSeries(categoryId); })
        .then(function (items) { renderItems(items, 'series'); })
        .catch(function (err) { renderMessage('Failed to load: ' + err.message); });
    }
  }

  function getOrFetch(cacheObj, key, fetchFn) {
    if (cacheObj[key]) return Promise.resolve(cacheObj[key]);
    return fetchFn().then(function (data) {
      cacheObj[key] = data || [];
      return cacheObj[key];
    });
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

  function renderItems(rawList, type) {
    els.itemList.innerHTML = '';
    if (!rawList || !rawList.length) {
      renderMessage('No items in this category.');
      return;
    }
    rawList.forEach(function (raw) {
      var item = normalizeItem(raw, type);
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
      if (e.keyCode === KEYS.ENTER) activateItem(item);
      if (e.keyCode === KEYS.GREEN) {
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
    var jobs = [];
    if (!state.cache.live.all) {
      jobs.push(Xtream.getLiveStreams().then(function (d) {
        state.cache.live.all = (d || []).map(function (r) { return normalizeItem(r, 'live'); });
      }).catch(function () { state.cache.live.all = []; }));
    }
    if (!state.cache.movies.all) {
      jobs.push(Xtream.getVodStreams().then(function (d) {
        state.cache.movies.all = (d || []).map(function (r) { return normalizeItem(r, 'movie'); });
      }).catch(function () { state.cache.movies.all = []; }));
    }
    if (!state.cache.series.all) {
      jobs.push(Xtream.getSeries().then(function (d) {
        state.cache.series.all = (d || []).map(function (r) { return normalizeItem(r, 'series'); });
      }).catch(function () { state.cache.series.all = []; }));
    }
    Promise.all(jobs).then(function () {
      if (state.currentTab === 'search' && els.searchInput.value.trim() === '') {
        renderMessage('Type to search across live TV, movies and series.');
      }
    });
  }

  function runSearch(query) {
    query = query.trim().toLowerCase();
    if (!query) { renderMessage('Type to search across live TV, movies and series.'); return; }
    var pools = [state.cache.live.all, state.cache.movies.all, state.cache.series.all];
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
  function clearPreviewTimer() {
    clearTimeout(state.previewTimer);
    state.previewTimer = null;
  }

  function updatePreviewInfo(item) {
    els.previewInfo.classList.add('active');
    els.previewName.textContent = item.name;
    var fav = isFavorite(item.type, item.id);
    els.previewFavBtn.classList.toggle('active', fav);
    els.previewFavBtn.textContent = fav ? '♥ Favorited' : '♡ Favorite';
  }

  function renderPreviewEmpty() {
    clearPreviewTimer();
    stopPreviewVideo();
    els.previewVideoWrap.classList.remove('active');
    els.previewPoster.classList.remove('active');
    els.previewInfo.classList.remove('active');
    els.previewEmpty.classList.add('active');
    state.previewItem = null;
  }

  function renderPreviewPoster(item) {
    clearPreviewTimer();
    stopPreviewVideo();
    els.previewEmpty.classList.remove('active');
    els.previewVideoWrap.classList.add('active');
    els.previewPoster.classList.add('active');
    els.previewPoster.style.visibility = '';
    els.previewPoster.src = item.icon || '';
    els.previewPoster.onerror = function () { els.previewPoster.style.visibility = 'hidden'; };
    state.previewItem = item;
    updatePreviewInfo(item);
  }

  function focusPreview(item) {
    clearPreviewTimer();
    if (item.type !== 'live') {
      renderPreviewPoster(item);
      return;
    }
    // Release any playing preview immediately so the provider's slow
    // connection-release timer starts as soon as possible, but only
    // *start* the new one after focus settles on this channel.
    if (state.previewPlaying) stopPreviewVideo();
    els.previewEmpty.classList.remove('active');
    els.previewPoster.classList.remove('active');
    // Show the (empty, black) preview box right away so the layout doesn't
    // jump when the debounce timer finishes and the video actually appears.
    els.previewVideoWrap.classList.add('active');
    els.previewStatus.textContent = 'Loading preview...';
    state.previewItem = item;
    updatePreviewInfo(item);
    state.previewTimer = setTimeout(function () { startLivePreview(item); }, PREVIEW_DEBOUNCE_MS);
  }

  function startLivePreview(item) {
    els.previewVideoWrap.appendChild(els.video);
    state.previewPlaying = item;
    els.video.src = Xtream.liveStreamUrl(item.id);
    els.video.play().catch(function () {});
  }

  function stopPreviewVideo() {
    clearPreviewTimer();
    if (els.video.parentNode === els.previewVideoWrap) {
      els.video.pause();
      els.video.removeAttribute('src');
      els.video.load();
      els.videoHome.appendChild(els.video);
    }
    state.previewPlaying = null;
    els.previewStatus.textContent = '';
  }

  els.video.addEventListener('playing', function () {
    if (els.video.parentNode === els.previewVideoWrap) els.previewStatus.textContent = '';
  });
  els.video.addEventListener('waiting', function () {
    if (els.video.parentNode === els.previewVideoWrap) els.previewStatus.textContent = 'Buffering...';
  });
  els.video.addEventListener('error', function () {
    if (els.video.parentNode === els.previewVideoWrap && state.previewPlaying) {
      els.previewStatus.textContent = 'Preview unavailable right now.';
    }
  });

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
    stopPreviewVideo();
    state.currentSeries = item;
    els.seriesTitle.textContent = item.name;
    els.seasonList.innerHTML = '';
    els.episodeList.innerHTML = '';
    showScreen('series');
    Xtream.getSeriesInfo(item.id).then(function (data) {
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
        if (e.keyCode === KEYS.ENTER) playEpisode(ep);
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
  function playItem(item) {
    state.returnScreen = 'home';

    // If this exact channel is already loaded and playing in the preview,
    // just move the same <video> element into fullscreen — no src change,
    // no reconnect, no waiting on the provider's connection limit.
    if (item.type === 'live' && state.previewPlaying === item &&
        els.video.parentNode === els.previewVideoWrap && !els.video.error) {
      enterFullscreenSeamless(item.name);
      return;
    }

    var url = item.type === 'live' ? Xtream.liveStreamUrl(item.id) : Xtream.vodStreamUrl(item.id, item.ext);
    startPlayback(url, item.name);
  }

  function enterFullscreenSeamless(title) {
    clearPreviewTimer();
    clearTimeout(state.retryTimer);
    state.retryCount = 0;
    state.playbackUrl = els.video.currentSrc || els.video.src;
    showScreenWithVideo('player', function () {
      els.screens.player.insertBefore(els.video, els.playerOverlay);
    });
    // Reparenting a <video> element implicitly pauses it in most engines,
    // even when it stays in the same document — the src/buffer are untouched
    // so this just resumes playback rather than reconnecting.
    els.video.play().catch(function () {});
    els.playerTitle.textContent = title || '';
    els.playerStatus.textContent = '';
    showOverlay();
    scheduleOverlayHide();
  }

  function startPlayback(url, title) {
    stopPreviewVideo();
    clearTimeout(state.retryTimer);
    state.playbackUrl = url;
    state.retryCount = 0;
    showScreenWithVideo('player', function () {
      els.screens.player.insertBefore(els.video, els.playerOverlay);
    });
    els.playerTitle.textContent = title || '';
    els.playerStatus.textContent = 'Loading...';
    showOverlay();
    els.video.src = url;
    els.video.play().catch(function () {});
  }

  function retryPlayback() {
    if (state.retryCount >= RETRY_DELAYS_MS.length) {
      els.playerStatus.textContent = 'Playback error. Your account allows only one connection ' +
        'at a time — make sure nothing else is using it, then press OK to retry.';
      showOverlay();
      return;
    }
    var delay = RETRY_DELAYS_MS[state.retryCount];
    state.retryCount++;
    // Keep the first few retries looking like ordinary buffering — most of
    // the time the connection frees up quickly, and surfacing "connection
    // busy" language only once it's taking a while avoids alarming the user
    // over what is usually just a brief reconnect.
    els.playerStatus.textContent = state.retryCount <= 3
      ? 'Buffering...'
      : 'Still reconnecting… your account allows only one connection at a time.';
    showOverlay();
    state.retryTimer = setTimeout(function () {
      els.video.src = state.playbackUrl;
      els.video.play().catch(function () {});
    }, delay);
  }

  els.video.addEventListener('playing', function () {
    if (els.video.parentNode !== els.screens.player) return;
    clearTimeout(state.retryTimer);
    state.retryCount = 0;
    els.playerStatus.textContent = '';
    scheduleOverlayHide();
  });
  els.video.addEventListener('waiting', function () {
    if (els.video.parentNode !== els.screens.player) return;
    els.playerStatus.textContent = 'Buffering...';
    showOverlay();
  });
  els.video.addEventListener('error', function () {
    if (els.video.parentNode === els.screens.player && state.playbackUrl) retryPlayback();
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
    clearTimeout(state.retryTimer);
    state.playbackUrl = null;
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
    els.videoHome.appendChild(els.video);
  }

  // Returning from fullscreen to a channel that's still the one being
  // previewed just moves the video back into the small preview box instead
  // of tearing the connection down — you were just watching it, so backing
  // out shouldn't force a fresh 45-90s reconnect if you look at it again.
  function exitFullscreenToPreview() {
    clearTimeout(state.retryTimer);
    state.playbackUrl = null;
    state.retryCount = 0;
    showScreenWithVideo('home', function () {
      els.previewVideoWrap.appendChild(els.video);
      els.previewVideoWrap.classList.add('active');
      els.previewPoster.classList.remove('active');
    });
    // Reparenting pauses the video (see enterFullscreenSeamless) — resume it.
    els.video.play().catch(function () {});
  }

  // Release the stream connection as soon as the app is backgrounded or
  // closed, since most Xtream providers cap simultaneous connections (often
  // to just 1) and only free the slot after the client stops requesting
  // segments — leaving a paused/open stream blocks all future playback.
  function releaseIfPlaying() {
    if (els.video.currentSrc) {
      stopPlayback();
      stopPreviewVideo();
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) releaseIfPlaying();
  });
  window.addEventListener('pagehide', releaseIfPlaying);
  window.addEventListener('webOSRelaunch', releaseIfPlaying);

  // ---------- Global key handling ----------
  document.addEventListener('keydown', function (e) {
    var code = e.keyCode;

    if (els.screens.player.classList.contains('active')) {
      if (code === KEYS.BACK || code === KEYS.BACKSPACE) {
        e.preventDefault();
        if (state.returnScreen === 'home' && state.previewPlaying &&
            els.video.currentSrc === Xtream.liveStreamUrl(state.previewPlaying.id) && !els.video.error) {
          exitFullscreenToPreview();
        } else {
          stopPlayback();
          showScreen(state.returnScreen);
        }
      } else if (code === KEYS.ENTER || code === KEYS.PLAY || code === KEYS.PAUSE) {
        if (els.video.error && state.playbackUrl) {
          clearTimeout(state.retryTimer);
          state.retryCount = 0;
          els.playerStatus.textContent = 'Retrying...';
          showOverlay();
          els.video.src = state.playbackUrl;
          els.video.play().catch(function () {});
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
        stopPreviewVideo();
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
