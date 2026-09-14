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

  function request(action, extraParams) {
    var url = apiUrl(action, extraParams);
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function authenticate() {
    return request('').then(function (data) {
      if (!data || !data.user_info || data.user_info.auth !== 1) {
        throw new Error('Invalid credentials');
      }
      return data;
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

  function liveStreamUrl(streamId) {
    return state.baseUrl + '/live/' + encodeURIComponent(state.username) + '/' +
      encodeURIComponent(state.password) + '/' + streamId + '.m3u8';
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
