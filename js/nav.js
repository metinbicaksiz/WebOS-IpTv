// Zone-aware focus navigation for remote-control d-pad.
// Pure geometric nearest-neighbor breaks down when a horizontal tab bar
// sits above a two-column list/grid layout, so each screen's containers
// are treated as explicit zones with their own directional rules.
var Nav = (function () {

  function visible(el) {
    return !!el && el.offsetParent !== null && !el.disabled;
  }

  function getFocusables(root) {
    var all = root.querySelectorAll('[tabindex], button, input');
    return Array.prototype.filter.call(all, visible);
  }

  function activeScreen() {
    return document.querySelector('.screen.active');
  }

  function focusFirst(root) {
    root = root || activeScreen();
    if (!root) return;
    var list = getFocusables(root);
    if (list.length) list[0].focus();
  }

  function focusEl(el) {
    if (!el) return false;
    el.focus();
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  function children(container) {
    return container ? Array.prototype.filter.call(container.children, visible) : [];
  }

  function closestByX(list, x) {
    if (!list.length) return null;
    var best = list[0], bestDist = Infinity;
    list.forEach(function (el) {
      var ex = el.getBoundingClientRect().left;
      var d = Math.abs(ex - x);
      if (d < bestDist) { bestDist = d; best = el; }
    });
    return best;
  }

  function closestByY(list, y) {
    if (!list.length) return null;
    var best = list[0], bestDist = Infinity;
    list.forEach(function (el) {
      var ey = el.getBoundingClientRect().top;
      var d = Math.abs(ey - y);
      if (d < bestDist) { bestDist = d; best = el; }
    });
    return best;
  }

  // Generic fallback: nearest-neighbor geometric search (used for simple
  // single-column/row layouts like the login form or a tile row, where
  // the more specific zone rules below don't apply).
  function geometricMove(direction, root, current) {
    var candidates = getFocusables(root);
    var curRect = current.getBoundingClientRect();
    var cx = curRect.left + curRect.width / 2;
    var cy = curRect.top + curRect.height / 2;
    var best = null, bestScore = Infinity;

    candidates.forEach(function (el) {
      if (el === current) return;
      var r = el.getBoundingClientRect();
      var ex = r.left + r.width / 2;
      var ey = r.top + r.height / 2;
      var dx = ex - cx, dy = ey - cy;
      var primary, perpendicular;
      if (direction === 'left') {
        if (dx >= -1) return;
        primary = -dx; perpendicular = Math.abs(dy);
      } else if (direction === 'right') {
        if (dx <= 1) return;
        primary = dx; perpendicular = Math.abs(dy);
      } else if (direction === 'up') {
        if (dy >= -1) return;
        primary = -dy; perpendicular = Math.abs(dx);
      } else if (direction === 'down') {
        if (dy <= 1) return;
        primary = dy; perpendicular = Math.abs(dx);
      }
      var score = primary + perpendicular * 1.5;
      if (score < bestScore) { bestScore = score; best = el; }
    });

    return focusEl(best);
  }

  function move(direction) {
    var root = activeScreen();
    if (!root) return;
    var current = document.activeElement;
    var candidates = getFocusables(root);
    if (!candidates.length) return;

    if (!current || candidates.indexOf(current) === -1) {
      candidates[0].focus();
      return true;
    }

    // Text cursor movement takes priority over zone navigation.
    if (current.tagName === 'INPUT' && (direction === 'left' || direction === 'right')) {
      return false;
    }

    var menuHeader = document.getElementById('menu-header');
    var menuTiles = document.getElementById('menu-tiles');
    var browseHeader = document.getElementById('browse-header');
    var categoryList = document.getElementById('category-list');
    var itemList = document.getElementById('item-list');
    var previewPanel = document.getElementById('preview-panel');
    var seriesBack = document.getElementById('series-back');
    var seasonList = document.getElementById('season-list');
    var episodeList = document.getElementById('episode-list');

    // ---------- Main menu screen ----------
    if (menuHeader && menuHeader.contains(current)) {
      if (direction === 'down') return focusEl(children(menuTiles)[0]);
      if (direction === 'left' || direction === 'right') return geometricMove(direction, menuHeader, current);
      return false;
    }
    if (menuTiles && menuTiles.contains(current)) {
      if (direction === 'left' || direction === 'right') {
        return geometricMove(direction, menuTiles, current);
      }
      if (direction === 'up') {
        return focusEl(closestByX(getFocusables(menuHeader), current.getBoundingClientRect().left));
      }
      return false;
    }

    // ---------- Browse screen zones ----------
    if (browseHeader && browseHeader.contains(current)) {
      if (direction === 'left' || direction === 'right') {
        return geometricMove(direction, browseHeader, current);
      }
      if (direction === 'down') {
        var firstCat = children(categoryList)[0];
        if (firstCat) return focusEl(firstCat);
        return focusEl(children(itemList)[0]);
      }
      return false;
    }

    if (categoryList && categoryList.contains(current)) {
      var catItems = children(categoryList);
      var catIdx = catItems.indexOf(current);
      if (direction === 'up') {
        if (catIdx > 0) return focusEl(catItems[catIdx - 1]);
        return focusEl(closestByX(children(browseHeader), current.getBoundingClientRect().left));
      }
      if (direction === 'down') {
        if (catIdx < catItems.length - 1) return focusEl(catItems[catIdx + 1]);
        return false;
      }
      if (direction === 'right') {
        return focusEl(closestByY(children(itemList), current.getBoundingClientRect().top));
      }
      return false; // left: already leftmost column
    }

    if (itemList && itemList.contains(current)) {
      var items = children(itemList);
      var idx = items.indexOf(current);
      if (direction === 'up') {
        if (idx > 0) return focusEl(items[idx - 1]);
        return focusEl(closestByX(children(browseHeader), current.getBoundingClientRect().left));
      }
      if (direction === 'down') {
        if (idx < items.length - 1) return focusEl(items[idx + 1]);
        return false;
      }
      if (direction === 'left') {
        return focusEl(closestByY(children(categoryList), current.getBoundingClientRect().top));
      }
      if (direction === 'right') {
        return focusEl(closestByY(children(previewPanel), current.getBoundingClientRect().top));
      }
    }

    if (previewPanel && previewPanel.contains(current)) {
      if (direction === 'left') {
        return focusEl(closestByY(children(itemList), current.getBoundingClientRect().top));
      }
      return false;
    }

    // ---------- Series detail screen zones ----------
    if (seriesBack && current === seriesBack) {
      if (direction === 'down') {
        return focusEl(children(seasonList)[0] || children(episodeList)[0]);
      }
      return false;
    }

    if (seasonList && seasonList.contains(current)) {
      var seasonItems = children(seasonList);
      var sIdx = seasonItems.indexOf(current);
      if (direction === 'up') {
        if (sIdx > 0) return focusEl(seasonItems[sIdx - 1]);
        return focusEl(seriesBack);
      }
      if (direction === 'down') {
        if (sIdx < seasonItems.length - 1) return focusEl(seasonItems[sIdx + 1]);
        return false;
      }
      if (direction === 'right') {
        return focusEl(closestByY(children(episodeList), current.getBoundingClientRect().top));
      }
      return false;
    }

    if (episodeList && episodeList.contains(current)) {
      var epItems = children(episodeList);
      var eIdx = epItems.indexOf(current);
      if (direction === 'up') {
        if (eIdx > 0) return focusEl(epItems[eIdx - 1]);
        return false;
      }
      if (direction === 'down') {
        if (eIdx < epItems.length - 1) return focusEl(epItems[eIdx + 1]);
        return false;
      }
      if (direction === 'left') {
        return focusEl(closestByY(children(seasonList), current.getBoundingClientRect().top));
      }
      return false;
    }

    // ---------- Fallback (e.g. login form) ----------
    return geometricMove(direction, root, current);
  }

  return { move: move, focusFirst: focusFirst, getFocusables: getFocusables };
})();
