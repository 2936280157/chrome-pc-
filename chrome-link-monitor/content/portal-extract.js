'use strict';

(function () {
  try {
    var PORTAL_LIST_PATH_RE = /(?:^|\/)(?:index|home|list|affiche|notice|trade|query|search|more)(?:\/|$|\?)/i;
    var PORTAL_DETAIL_PATH_RE = /(?:detail|view|info|content|article|show|guid|afficheDetail|noticeDetail|tradeDetail|proj|bulletin|announce)/i;

    function looksLikePortalDetailPage(url) {
      if (!url) {
        return false;
      }
      try {
        var parsed = new URL(url);
        var path = (parsed.pathname || '').toLowerCase();
        if (PORTAL_DETAIL_PATH_RE.test(path)) {
          return true;
        }
        if (PORTAL_LIST_PATH_RE.test(path) && !PORTAL_DETAIL_PATH_RE.test(path)) {
          return false;
        }
        var segments = path.split('/').filter(Boolean);
        if (segments.length >= 3) {
          var last = segments[segments.length - 1];
          if (/^\d{5,}$/.test(last) || /[0-9a-f]{12,}/i.test(last)) {
            return true;
          }
        }
        return false;
      } catch (e) {
        return false;
      }
    }

    function isExtNode(el) {
      if (!el || !el.closest) {
        return false;
      }
      return el.closest('[id*="link-monitor"], [id*="lm-ahtba"]');
    }

    function pickCoreText() {
      var detailSelectors = [
        'article', '.article-content', '.detail-content', '.content-detail',
        '.notice-content', '.affiche-content', '#content', 'main', '.main-content'
      ];
      if (looksLikePortalDetailPage(location.href)) {
        for (var d = 0; d < detailSelectors.length; d++) {
          var detailEl = document.querySelector(detailSelectors[d]);
          if (detailEl && (detailEl.innerText || '').trim().length >= 40) {
            return (detailEl.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 15000);
          }
        }
      }
      if (document.body) {
        return (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 15000);
      }
      return '';
    }

    var pageUrl = location.href;
    var parts = [];
    var seen = {};
    if (!looksLikePortalDetailPage(pageUrl)) {
      var nodes = document.querySelectorAll('table tbody tr, ul li, .list-item, a[href]');
      for (var i = 0; i < nodes.length && parts.length < 80; i++) {
        if (isExtNode(nodes[i])) {
          continue;
        }
        var text = (nodes[i].innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 6 && !seen[text]) {
          seen[text] = true;
          parts.push(text.slice(0, 160));
        }
      }
    }
    var listSnap = parts.join('\n');
    var listRows = listSnap ? listSnap.split('\n').filter(function (l) {
      return l.trim().length >= 6;
    }).length : 0;
    var bodyText = pickCoreText();
    var core = (listRows >= 4 && listSnap) ? 'LIST::' + listSnap + '\nBODY::' + bodyText : bodyText;
    return {
      raw: document.documentElement ? document.documentElement.outerHTML.slice(0, 300000) : '',
      core: core,
      overlaySignature: ''
    };
  } catch (e) {
    return { raw: '', core: '', overlaySignature: '' };
  }
})();
