// Minimal Xtream Codes API client
var Xtream = (function () {
  var state = { baseUrl: '', username: '', password: '' };

  function normalizeUrl(url) {
    url = url.trim();
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    return url.replace(/\/+$/, '');
  }

  function configure(baseUrl, username, password) {
    state.baseUrl = normalizeUrl(baseUrl);
    state.username = username.trim();
    state.password = password;
  }

  function apiUrl(action, extraParams) {
    var params = 'username=' + encodeURIComponent(state.username) +
      '&password=' + encodeURIComponent(state.password) +
      (action ? '&action=' + action : '');
    if (extraParams) params += '&' + extraParams;
    return state.baseUrl + '/player_api.php?' + params;
  }

  // Every API call goes through a single queue so the app never has more
  // than one request open to the provider at a time — accounts limited to a
  // single connection can count parallel player_api.php hits against that
  // limit. Identical requests already queued/in flight share one result.
  var REQUEST_TIMEOUT_MS = 60000;
  var REQUEST_GAP_MS = 250;
  var queueTail = Promise.resolve();
  var pending = {};

  function fetchJson(url) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('Request timed out')); }, REQUEST_TIMEOUT_MS);
      fetch(url).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (data) {
        clearTimeout(timer);
        resolve(data);
      }, function (err) {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function request(action, extraParams) {
    var url = apiUrl(action, extraParams);
    if (pending[url]) return pending[url];
    var run = function () {
      return fetchJson(url).then(function (data) {
        return new Promise(function (r) { setTimeout(function () { r(data); }, REQUEST_GAP_MS); });
      });
    };
    var p = queueTail.then(run, run);
    queueTail = p.catch(function () {});
    pending[url] = p;
    var done = function () { delete pending[url]; };
    p.then(done, done);
    return p;
  }

  function authenticate() {
    return request('').then(function (data) {
      if (!data || !data.user_info || data.user_info.auth !== 1) {
        throw new Error('Invalid credentials');
      }
      return data;
    });
  }

  // Lightweight account status (active_cons / max_connections). Hitting
  // player_api.php doesn't open a stream, so it's safe to poll this while
  // waiting for the provider to release a previous stream slot.
  function getAccountInfo() {
    return request('').then(function (data) {
      return (data && data.user_info) || {};
    });
  }

  function getLiveCategories() { return request('get_live_categories'); }
  function getLiveStreams(categoryId) {
    return request('get_live_streams', categoryId ? 'category_id=' + encodeURIComponent(categoryId) : null);
  }

  function getVodCategories() { return request('get_vod_categories'); }
  function getVodStreams(categoryId) {
    return request('get_vod_streams', categoryId ? 'category_id=' + encodeURIComponent(categoryId) : null);
  }

  function getSeriesCategories() { return request('get_series_categories'); }
  function getSeries(categoryId) {
    return request('get_series', categoryId ? 'category_id=' + encodeURIComponent(categoryId) : null);
  }
  function getSeriesInfo(seriesId) {
    return request('get_series_info', 'series_id=' + encodeURIComponent(seriesId));
  }

  // 'ts' (the default, as the desktop IPTV Stream Player uses) is a single
  // continuous HTTP connection: closing it frees the provider's slot
  // immediately. 'm3u8' (HLS) polls segments, so the provider can only
  // time the session out — often minutes after playback stopped.
  function liveStreamUrl(streamId, format) {
    return state.baseUrl + '/live/' + encodeURIComponent(state.username) + '/' +
      encodeURIComponent(state.password) + '/' + streamId + '.' + (format || 'ts');
  }

  function vodStreamUrl(streamId, ext) {
    return state.baseUrl + '/movie/' + encodeURIComponent(state.username) + '/' +
      encodeURIComponent(state.password) + '/' + streamId + '.' + (ext || 'mp4');
  }

  function seriesEpisodeUrl(episodeId, ext) {
    return state.baseUrl + '/series/' + encodeURIComponent(state.username) + '/' +
      encodeURIComponent(state.password) + '/' + episodeId + '.' + (ext || 'mp4');
  }

  return {
    configure: configure,
    authenticate: authenticate,
    getAccountInfo: getAccountInfo,
    getLiveCategories: getLiveCategories,
    getLiveStreams: getLiveStreams,
    getVodCategories: getVodCategories,
    getVodStreams: getVodStreams,
    getSeriesCategories: getSeriesCategories,
    getSeries: getSeries,
    getSeriesInfo: getSeriesInfo,
    liveStreamUrl: liveStreamUrl,
    vodStreamUrl: vodStreamUrl,
    seriesEpisodeUrl: seriesEpisodeUrl
  };
})();
